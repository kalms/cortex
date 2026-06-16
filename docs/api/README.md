# Cortex HTTP API — Consumer Reference (v1)

This directory holds the **generated** JSON Schema for every Cortex HTTP
response, plus this consumer-facing reference. The schemas are produced from the
Zod definitions in
[`src/mcp-server/api-schemas.ts`](../../src/mcp-server/api-schemas.ts) — they are
output, not input. **Do not hand-edit the `*.schema.json` files**; edit the Zod
schema and run `npm run gen:api-schemas` (a drift-guard test fails CI if the
committed JSON diverges). For the architecture, rationale, and the
"add an endpoint" workflow, see
[`docs/architecture/http-api-contract.md`](../architecture/http-api-contract.md).

The base URL is `http://<CORTEX_BIND_HOST>:<CORTEX_VIEWER_PORT>` (default
`http://127.0.0.1:3333`, or `:3334` in dev). All endpoints are **`GET`** (with
`HEAD` also accepted for cheap revalidation). Every response includes a
top-level `version` field equal to `1`.

## Endpoints

| Path | Auth* | Query / path params | Body (top-level fields) | Conditional GET |
|---|---|---|---|---|
| `/api/health` | **exempt** | — | `{ version, ok: true }` | — |
| `/api/freshness` | required | `?project=<name>` | `{ version, state, commits_behind?, dirty?, indexed_at?, note? }` | — |
| `/api/projects` | required | — | `{ version, projects[], active }` | — † |
| `/api/graph` | required | `?project=<name>` | `{ version, nodes[], edges[], project }` | `ETag` / `304` |
| `/api/frames` | required | `?project=<name>` | `{ version, frames[], stage }` | `ETag` / `304` |
| `/api/file-edges` | required | `?project=<name>` | `{ version, file_edges[] }` | `ETag` / `304` |
| `/api/aggregates` | required | `?project=<name>` | `{ version, aggregates[] }` | `ETag` / `304` |
| `/api/decisions` | required | `?project=<name>` | `{ version, decisions[] }` | `ETag` / `304` |
| `/api/decisions/:id` | required | path `:id`, `?project=<name>` | `{ version, decision }` | `ETag` / `304` |

\* "required" applies **only when `CORTEX_API_TOKEN` is set** — auth is off by
default for local use. When set, every `/api/*` path **except `/api/health`**
requires `Authorization: Bearer <token>`.

† `/api/projects` is **not** auth-exempt — it exposes each project's `root_path`
(a filesystem path), which is why a dedicated, data-free `/api/health` exists for
liveness probing. It reads the machine-wide registry rather than a single
project's index baseline, so it does not participate in the per-project
graph-baseline `304` path the data endpoints use (it still carries the version
and freshness headers).

The shared `?project=<name>` selects which indexed project to serve; when
omitted, the server's bound (active) project is used. An invalid `project`
parameter or an invalid decision `:id` returns **`400 Bad Request`**.

### Per-endpoint notes

- **`/api/freshness`** returns the live staleness verdict for the resolved
  project. `state` is one of `fresh | stale:commits | stale:dirty | stale:both |
  empty | unknown`. `commits_behind`, `dirty`, and `indexed_at` are present when
  the verdict carries them; the optional **`note`** is emitted on the
  `unknown`/`empty` verdicts (e.g. when the project is not in the registry, or
  the graph DB is unavailable). Honors `CORTEX_FRESHNESS=0` (always `fresh`).
- **`/api/graph`** — `nodes[]` mirror the graph store rows; each entry in
  `edges[]` includes both the raw `source_id`/`target_id` and the viewer
  `source`/`target` aliases. `project` echoes the resolved project (or `null`).
- **`/api/frames`** — `frames[]` are the frame map entries (id, name, count,
  placement `x/y/w/h` (nullable), `ambient`, `rank`, `score`, `layer`); `stage`
  is `{ w, h }`, the virtual-stage dimensions.
- **`/api/file-edges`** — `file_edges[]` are `{ from_path, to_path, weight }`,
  rolled up from CALLS / USAGE / IMPORTS relations.
- **`/api/aggregates`** — `aggregates[]` are auxiliary-path groups
  (`{ id, label, aux_segment, member_count, sample_paths[], x?, y? }`); `x`/`y`
  are the virtual-stage center pixels for *placed* aggregates and are absent for
  unplaced ones.
- **`/api/decisions` / `/api/decisions/:id`** — decisions adapted for rendering
  (`governs` links resolved to frame ids / file paths / symbols, `alternatives`,
  supersession + relation refs). `provenance` is a permissive record.

The exact field-level shape of each response is the corresponding
`*.schema.json` in this directory — the canonical, machine-readable contract.

## Generated schema files

| Endpoint | Schema |
|---|---|
| `/api/health` | [`health.schema.json`](./health.schema.json) |
| `/api/freshness` | [`freshness.schema.json`](./freshness.schema.json) |
| `/api/projects` | [`projects.schema.json`](./projects.schema.json) |
| `/api/graph` | [`graph.schema.json`](./graph.schema.json) |
| `/api/frames` | [`frames.schema.json`](./frames.schema.json) |
| `/api/file-edges` | [`file-edges.schema.json`](./file-edges.schema.json) |
| `/api/aggregates` | [`aggregates.schema.json`](./aggregates.schema.json) |
| `/api/decisions` | [`decisions.schema.json`](./decisions.schema.json) |
| `/api/decisions/:id` | [`decision-detail.schema.json`](./decision-detail.schema.json) |

## Response headers

Every `/api/*` response (including a `304`) carries:

| Header | Value |
|---|---|
| `X-Cortex-API-Version` | `1` — the contract version, inspectable without a body. |
| `X-Cortex-Freshness` | the live verdict `state` (same as `/api/freshness`'s `state`). |
| `ETag` | a strong validator derived from the project's index baseline. |
| `X-Content-Type-Options` | `nosniff`. |

The data endpoints support **conditional GET**: store the `ETag` you receive and
send it back as `If-None-Match` on your next request. If nothing has been
reindexed, the server replies **`304 Not Modified`** with an empty body and you
keep your cached copy — no full-graph transfer. The `ETag` changes only when the
graph is republished (a reindex), so it is the right cache key. A `HEAD` request
returns all the same headers (including `ETag`) with no body, for the cheapest
possible revalidation.

```
GET /api/graph?project=cortex
→ 200, ETag: "1:cortex:9f3a…"   (store this)

GET /api/graph?project=cortex
If-None-Match: "1:cortex:9f3a…"
→ 304 Not Modified              (graph unchanged — reuse cached data)
```

`X-Cortex-Freshness` is the orthogonal **staleness** signal: it tells you whether
the index is behind the working tree (so you might prompt a reindex), which is
independent of cache identity. Poll `/api/freshness` for the full verdict cheaply.

## Error responses

Errors use a fixed `{ "error": "<message>" }` body:

| Status | When |
|---|---|
| `400 Bad Request` | invalid `?project=` or decision `:id`. |
| `401 Unauthorized` | `CORTEX_API_TOKEN` set and the `Authorization: Bearer` token is missing/wrong. |
| `404 Not Found` | unknown decision id, or static path outside the viewer dir. |
| `405 Method Not Allowed` | method other than `GET`/`HEAD` (or `OPTIONS` from a non-allowlisted origin). |
| `414 URI Too Long` | request target longer than 2048 chars. |
| `503 Service Unavailable` | decisions repositories unavailable for a `/api/decisions*` request. |

## Environment variables

| Var | Default | Effect |
|---|---|---|
| `CORTEX_VIEWER_PORT` | `3333` (plugin) / `3334` (dev) | Listen port. |
| `CORTEX_BIND_HOST` | `127.0.0.1` | Bind interface; set `0.0.0.0` to deliberately expose on the LAN. |
| `CORTEX_API_TOKEN` | unset | When set, every `/api/*` path except `/api/health` requires `Authorization: Bearer <token>`. |
| `CORTEX_CORS_ORIGINS` | unset | Comma-separated browser-origin allowlist; only an allowlisted `Origin` is reflected. |
| `CORTEX_API_STRICT` | unset | `1` → response-validation failures return `500` in production too. |
| `CORTEX_FRESHNESS` | unset | `0` → the freshness verdict is always `fresh` (the ETag is unaffected). |

### A note on CORS

CORS only matters for **browser** consumers. Cortex's own `/viewer` is
same-origin, and Mesh fetches from Node (no CORS), so the default empty allowlist
is correct for both. Set `CORTEX_CORS_ORIGINS` only if you build a separate
browser client on another origin.
