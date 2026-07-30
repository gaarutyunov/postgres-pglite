// Main thread: spawns the worker that owns the Postgres instance and renders
// whatever it reports back. This file contains no SQL and no results of its
// own — if the worker fails, the page shows the failure.

const bootSteps = document.getElementById('boot-steps')
const bootLog = document.getElementById('boot-log')
const statementsEl = document.getElementById('statements')
const verdict = document.getElementById('verdict')

const stepNodes = new Map()
const cardNodes = []

function stepNode(id, label) {
  let li = stepNodes.get(id)
  if (!li) {
    li = document.createElement('li')
    li.className = 'step running'
    li.innerHTML = '<span class="mark"></span><span class="label"></span>'
    bootSteps.appendChild(li)
    stepNodes.set(id, li)
  }
  li.querySelector('.label').textContent = label
  return li
}

function renderStatementCards(statements) {
  statementsEl.textContent = ''
  statements.forEach((st, i) => {
    const card = document.createElement('article')
    card.className = 'card pending'

    const h = document.createElement('h3')
    h.innerHTML = `<span class="tag">${escapeHtml(st.title)}</span>`
    card.appendChild(h)

    if (st.note) {
      const p = document.createElement('p')
      p.className = 'note'
      p.textContent = st.note
      card.appendChild(p)
    }

    const pre = document.createElement('pre')
    pre.className = 'sql'
    pre.textContent = st.sql
    card.appendChild(pre)

    const out = document.createElement('div')
    out.className = 'out'
    out.textContent = 'waiting…'
    card.appendChild(out)

    statementsEl.appendChild(card)
    cardNodes.push({ card, out })
  })
}

function renderResult(msg) {
  const node = cardNodes[msg.index]
  if (!node) return
  const { card, out } = node
  out.textContent = ''

  if (msg.error) {
    card.className = 'card failed'
    const pre = document.createElement('pre')
    pre.className = 'error'
    pre.textContent = msg.error
    out.appendChild(pre)
    return
  }

  card.className = 'card ok'

  if (!msg.fields || msg.fields.length === 0) {
    const p = document.createElement('p')
    p.className = 'meta'
    p.textContent = `ok — ${msg.affected} row(s) affected, ${msg.ms} ms`
    out.appendChild(p)
    return
  }

  const wrap = document.createElement('div')
  wrap.className = 'tablewrap'
  const table = document.createElement('table')

  const thead = document.createElement('thead')
  const trh = document.createElement('tr')
  for (const f of msg.fields) {
    const th = document.createElement('th')
    th.textContent = f
    trh.appendChild(th)
  }
  thead.appendChild(trh)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const row of msg.rows) {
    const tr = document.createElement('tr')
    for (const f of msg.fields) {
      const td = document.createElement('td')
      td.textContent = formatValue(row[f])
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  out.appendChild(wrap)

  const p = document.createElement('p')
  p.className = 'meta'
  p.textContent = `${msg.rows.length} row(s), ${msg.ms} ms`
  out.appendChild(p)
}

function formatValue(v) {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })

worker.addEventListener('message', (ev) => {
  const msg = ev.data
  switch (msg.type) {
    case 'boot': {
      const li = stepNode(msg.step, msg.label)
      li.className = `step ${msg.status === 'ok' ? 'done' : 'running'}`
      break
    }
    case 'version': {
      document.getElementById('fact-version').textContent = msg.version
      break
    }
    case 'statements': {
      renderStatementCards(msg.statements)
      break
    }
    case 'result': {
      renderResult(msg)
      break
    }
    case 'done': {
      if (msg.failures === 0) {
        verdict.className = 'ok'
        verdict.textContent =
          `All ${msg.total} statements executed against the wasm build — ` +
          `including every GRAPH_TABLE query. Boot took ${msg.bootMs} ms.`
      } else {
        verdict.className = 'failed'
        verdict.textContent =
          `${msg.failures} of ${msg.total} statements FAILED. ` +
          `The build does not execute this SQL correctly.`
      }
      break
    }
    case 'fatal': {
      verdict.className = 'failed'
      verdict.textContent = 'The demo failed to boot. The build is not usable in the browser.'
      bootLog.hidden = false
      bootLog.textContent = msg.error
      for (const li of stepNodes.values()) {
        if (li.className.includes('running')) li.className = 'step failed'
      }
      break
    }
  }
})

worker.addEventListener('error', (ev) => {
  verdict.className = 'failed'
  verdict.textContent = 'Worker error — the build did not load.'
  bootLog.hidden = false
  bootLog.textContent = `${ev.message}\n${ev.filename}:${ev.lineno}`
})

// Fill in the build ref, written by the build workflow.
fetch('./build-info.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (!info) return
    document.getElementById('fact-ref').textContent = `${info.ref} @ ${info.sha.slice(0, 10)}`
  })
  .catch(() => {})
