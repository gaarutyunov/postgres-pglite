# SQL/PGQ browser demo

A live proof that the wasm32 build of this fork executes `GRAPH_TABLE` queries
in a browser. It boots Postgres in a Web Worker, runs [`demo.sql`](./demo.sql),
and renders whatever the engine returns.

Nothing here is mocked. `app.js` only draws what `worker.js` reports; if the
build fails to load or a query errors, the page says so instead of showing a
result.

## Which branch this is built from

The bundle is built from **`REL_19_BETA2-pglite`**, not from the repository's
default branch.

`REL_18_3-pglite` is Postgres 18.3 and contains no SQL/PGQ at all — no
`propgraphcmds.c`, no `parse_graphtable.c`, no `pg_propgraph_*` catalogs and no
`GRAPH_TABLE` production in `gram.y`. A bundle built from it compiles and boots
perfectly happily and then fails every query in `demo.sql`. Two guards exist so
that mistake cannot ship quietly:

- the build job refuses to start if the chosen ref lacks the SQL/PGQ sources;
- [`verify.mjs`](./verify.mjs) asserts the running server reports PostgreSQL 19.

## SQL/PGQ support level

Supported: `CREATE` / `ALTER` / `DROP PROPERTY GRAPH`; `GRAPH_TABLE` with
multi-element path patterns, both edge directions, the vertex-to-vertex
abbreviation `(a)->(b)`, label disjunction (`IS a | b`), per-element `WHERE`,
lateral references, and `COLUMNS` projections that compose with ordinary SQL.

Not supported in this patch set, and each raises a clear error rather than
misbehaving: element pattern quantifiers (`->{1,2}`), more than one path
pattern per `GRAPH_TABLE` clause, adjacent vertex patterns, non-local element
variable references, and reusing one variable name with different label
expressions.

## Running it

The demo needs a built bundle, which CI produces —
`.github/workflows/pglite-wasm.yml`, job `demo`, uploads the whole assembled
site as the `demo-site` artifact. To serve it locally:

```sh
unzip demo-site.zip -d site
cd site && python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Any static file server works; the build
uses `-sUSE_PTHREADS=0`, so no COOP/COEP headers are required.

To run the same SQL headlessly, without a browser:

```sh
node site/verify.mjs site/pglite
```

It exits non-zero if any statement errors, if a `GRAPH_TABLE` query returns no
rows, or if the server is not PostgreSQL 19.

To prove the browser path specifically — module workers, `fetch`, and browser
WebAssembly instantiation are not the same code path as Node:

```sh
(cd site && python3 -m http.server 8899 &)
python3 site/browser-check.py http://localhost:8899/
```

It drives headless Chrome over the DevTools Protocol and reports what the page
rendered. `--dump-dom` is no substitute: it fires on the load event, long before
the worker has booted Postgres, and reports an empty page. Both checks run in
CI on every push.

## Layout

| File | What it is |
| --- | --- |
| `demo.sql` | The hand-written schema, seed rows and graph queries |
| `worker.js` | Owns the PGlite instance; the only place SQL is executed |
| `app.js` | Renders what the worker reports; contains no SQL |
| `verify.mjs` | The Node gate CI runs |
| `browser-check.py` | The real-browser gate CI runs (CDP, stdlib only) |
| `index.html`, `style.css` | The page |

`pglite/` and `build-info.json` are build output and are gitignored.

## Why the JS runtime is built from source

The demo does not use the published `@electric-sql/pglite` npm bundle. PGlite's
emscripten glue hard-checks the FS bundle's byte length against a value baked
in at link time, so the published package rejects any `pglite.data` but the one
it shipped with. The runtime therefore has to be built against *this* fork's
`pglite.js`, `pglite.wasm`, `pglite.data` and `initdb.wasm` — which is exactly
what PGlite's own `wasm:copy-pglite` script does with `dist/bin/`.

This matters for anyone consuming the release: the `.wasm` and the FS bundle
alone are not loadable. The matching glue has to travel with them.
