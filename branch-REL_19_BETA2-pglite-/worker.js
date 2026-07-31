// Web Worker that boots the wasm32 Postgres build and runs the demo SQL.
//
// The PGlite JS runtime in ./pglite/ is built against *this fork's* emscripten
// output: pglite.js (the glue), pglite.wasm, pglite.data and initdb.wasm all
// come from the same build, which is required because the glue hard-checks the
// FS bundle's byte length against a value baked in at link time.
//
// No dataDir is passed, so Postgres runs entirely in memory.

import { PGlite } from './pglite/index.js'

const post = (type, payload) => self.postMessage({ type, ...payload })

/**
 * Split the demo SQL into labelled statements.
 *
 * The file uses `-- Qn:` / numbered section comments as headings; anything
 * between one heading and the next is one logical step. Splitting on `;` at
 * end-of-line is sufficient here because the demo SQL deliberately contains no
 * dollar-quoted bodies or semicolons inside literals.
 */
function parseStatements(sql) {
  const out = []
  let comment = []

  for (const rawChunk of sql.split(/;\s*(?:\r?\n|$)/)) {
    const chunk = rawChunk.trim()
    if (!chunk) continue

    const lines = chunk.split(/\r?\n/)
    const lead = []
    let i = 0
    for (; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line === '' || line.startsWith('--')) {
        lead.push(line)
      } else {
        break
      }
    }
    const body = lines.slice(i).join('\n').trim()
    if (!body) {
      comment = comment.concat(lead)
      continue
    }

    const commentary = comment
      .concat(lead)
      .map((l) => l.replace(/^--\s?/, '').trim())
      .filter((l) => l && !/^-{3,}$/.test(l))
    comment = []

    // A `-- Qn:` marker means "render this one's rows".
    const qMatch = commentary.join(' ').match(/\bQ(\d+):/)
    out.push({
      sql: body,
      title: qMatch ? `Q${qMatch[1]}` : firstWords(body),
      note: commentary.join(' ').replace(/^\d+\.\s*/, ''),
      isQuery: /^\s*SELECT/i.test(body),
    })
  }
  return out
}

function firstWords(sql) {
  const m = sql.match(/^\s*(CREATE\s+PROPERTY\s+GRAPH|CREATE\s+TABLE|INSERT\s+INTO)\s+(\S+)/i)
  return m ? `${m[1].replace(/\s+/g, ' ').toUpperCase()} ${m[2].replace(/[(;].*/, '')}` : sql.slice(0, 40)
}

async function main() {
  post('boot', { step: 'fetch', status: 'start', label: 'Fetching demo SQL' })
  const sql = await (await fetch('./demo.sql')).text()
  const statements = parseStatements(sql)
  post('boot', { step: 'fetch', status: 'ok', label: `Parsed ${statements.length} statements` })

  post('boot', { step: 'boot', status: 'start', label: 'Booting Postgres (wasm32, in-memory)' })
  const t0 = performance.now()

  const db = new PGlite({
    // In-memory: no dataDir at all.
    debug: 0,
  })
  await db.waitReady

  const bootMs = Math.round(performance.now() - t0)
  post('boot', { step: 'boot', status: 'ok', label: `Postgres ready in ${bootMs} ms` })

  // Report the real server version before anything else runs.
  const ver = await db.query('SELECT version()')
  post('version', { version: ver.rows[0].version })

  post('statements', { statements: statements.map(({ sql, title, note, isQuery }) => ({ sql, title, note, isQuery })) })

  let failures = 0
  for (let i = 0; i < statements.length; i++) {
    const st = statements[i]
    const started = performance.now()
    try {
      const res = await db.query(st.sql)
      post('result', {
        index: i,
        ms: Math.round(performance.now() - started),
        fields: (res.fields ?? []).map((f) => f.name),
        rows: res.rows ?? [],
        affected: res.affectedRows ?? 0,
      })
    } catch (err) {
      failures++
      post('result', {
        index: i,
        ms: Math.round(performance.now() - started),
        error: String(err && err.message ? err.message : err),
      })
    }
  }

  post('done', { failures, total: statements.length, bootMs })
}

main().catch((err) => {
  post('fatal', { error: String(err && err.stack ? err.stack : err) })
})
