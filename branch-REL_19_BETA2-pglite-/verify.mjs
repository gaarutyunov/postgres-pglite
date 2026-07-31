#!/usr/bin/env node
// Headless gate for the wasm build: boots the same PGlite runtime the browser
// demo uses and runs demo/demo.sql against it, in memory.
//
// Exits non-zero if any statement errors, if any GRAPH_TABLE query returns no
// rows, or if the reported server version is not PostgreSQL 19. That last check
// matters because a build accidentally cut from the 18.3 branch would compile
// and boot perfectly happily while having no SQL/PGQ at all.
//
// Usage: node demo/verify.mjs [path-to-pglite-dist]

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distPath = resolve(process.argv[2] ?? resolve(here, 'pglite'), 'index.js')

const { PGlite } = await import(pathToFileURL(distPath).href)

const sql = await readFile(resolve(here, 'demo.sql'), 'utf8')

// Same split the worker uses: `;` at end of line. The demo SQL deliberately
// avoids dollar-quoting and semicolons inside literals.
const statements = sql
  .split(/;\s*(?:\r?\n|$)/)
  .map((chunk) =>
    chunk
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim(),
  )
  .filter(Boolean)

// Which statements are the graph queries we are actually here to prove.
const graphQueries = statements.filter((s) => /GRAPH_TABLE/i.test(s) && /^\s*SELECT/i.test(s))

console.log(`verify: ${statements.length} statements, ${graphQueries.length} GRAPH_TABLE queries`)

const db = new PGlite({ debug: 0 })
await db.waitReady

let failed = 0

const version = (await db.query('SELECT version()')).rows[0].version
console.log(`verify: server reports: ${version}`)
if (!/PostgreSQL 19/.test(version)) {
  console.error(`verify: FAIL — expected PostgreSQL 19, got: ${version}`)
  failed++
}

for (const stmt of statements) {
  const label = stmt.replace(/\s+/g, ' ').slice(0, 72)
  const isGraphQuery = graphQueries.includes(stmt)
  try {
    const res = await db.query(stmt)
    if (isGraphQuery) {
      const n = res.rows.length
      if (n === 0) {
        console.error(`verify: FAIL — GRAPH_TABLE query returned 0 rows: ${label}`)
        failed++
        continue
      }
      console.log(`verify: ok (${n} rows) ${label}`)
      console.log(formatTable(res.fields.map((f) => f.name), res.rows))
    } else {
      console.log(`verify: ok ${label}`)
    }
  } catch (err) {
    console.error(`verify: FAIL — ${label}\n        ${err.message ?? err}`)
    failed++
  }
}

await db.close()

if (failed > 0) {
  console.error(`\nverify: ${failed} failure(s) — the build does NOT execute this SQL.`)
  process.exit(1)
}
console.log(`\nverify: all ${statements.length} statements executed, all GRAPH_TABLE queries returned rows.`)

function formatTable(cols, rows) {
  const cell = (v) =>
    v === null || v === undefined
      ? 'NULL'
      : v instanceof Date
        ? v.toISOString().slice(0, 10)
        : String(v)
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => cell(r[cols[i]]).length)),
  )
  const line = (cells) => '        | ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
  return [
    line(cols),
    '        |' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|',
    ...rows.map((r) => line(cols.map((c) => cell(r[c])))),
  ].join('\n')
}
