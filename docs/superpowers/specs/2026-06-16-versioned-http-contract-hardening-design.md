# Versioned, Zod-Enforced HTTP Contract + Freshness + Hardening — Design

> Status: **design approved** (2026-06-16). Implementation plan to be derived via
> `superpowers:writing-plans`. This is P6 from [HANDOFF.md](../../../HANDOFF.md)
> — *Versioned HTTP contract + freshness over HTTP* — **expanded** to include a
> full security-hardening pass on the HTTP surface.

Branch: `feature/api/versioned-contract-hardening` · Worktree:
`../cortex-wt-api-contract`

---

## 1. Problem & motivation

The Cortex viewer HTTP server (`src/mcp-server/api.ts`, `startViewerServer`)
exposes seven endpoints — `/api/graph`, `/api/projects`, `/api/decisions`,
`/api/decisions/:id`, `/api/frames`, `/api/file-edges`, `/api/aggregates` — that
Mesh consumes live as its substrate-canvas data source. Today every response is
a hand-built `JSON.stringify(...)` with:

- **No versioning.** No `version` field anywhere; consumers can't detect a
  contract break.
- **No runtime validation.** TypeScript interfaces (`AdaptedDecision`,
  `FileEdge`, `GovernsRef`) exist but are compile-time only — nothing checks the
  wire shape, and `/api/graph` ships raw `NodeRow`/`EdgeRow` store rows with no
  boundary type at all.
- **No freshness on the wire.** The freshness verdict rides MCP tool responses
  only. Mesh wanted a cache "keyed on cortex's freshness verdict" (its D10) but
  couldn't build it, so it fell back to a **blind 30 s TTL** (its own comment in
  `packages/core/src/cortex/client.ts` calls this out as a spec deviation).
- **An exposed, unhardened surface.** The server binds **all interfaces**
  (`listen(port)` with no host → `0.0.0.0`/`::`), serves static files with a
  **path-traversal** hole (`join(VIEWER_DIR, url.replace(/^\/viewer\//, ""))`),
  sets **wildcard CORS** (`Access-Control-Allow-Origin: *`) on every response,
  does no method gating, and has no auth. Cortex is local today, but the surface
  should be safe to deliberately expose later.

P6 **gates Mesh**: it must land before Mesh's viewer-adaptation milestone starts
consuming `/api/frames`.

### Why Zod-enforced, not docs-only

The HANDOFF's literal wording — "freeze JSON Schemas under `docs/api/`" —
produces a *fourth* artifact (alongside the TS interface, the hand-built object,
and the prose docs) that can silently drift. We invert it: **one Zod schema per
response is the single source of truth** → it validates at runtime, derives the
TS type via `z.infer`, and *generates* the JSON Schema docs. The docs become a
guarded, generated artifact that structurally cannot drift from the code. Zod
`^3.24.4` is already a dependency.

## 2. Goals / non-goals

**Goals**

1. A **versioned**, **Zod-enforced** contract for all seven endpoints — runtime
   validation + `z.infer` types + generated JSON Schema docs from one source.
2. **Freshness over HTTP** so Mesh replaces its blind TTL with verdict-keyed,
   conditional revalidation.
3. A **full hardening pass**: loopback-default bind, path-traversal guard, CORS
   allowlist, method gate, request-input validation, opt-in bearer auth, security
   headers, basic limits — designed so the surface is safe to deliberately
   expose.
4. **Substantial, onboarding-grade documentation** of the contract and its
   maintenance workflow (first-class deliverable — see §11).

**Non-goals (YAGNI)**

- TLS termination (a reverse proxy's job if ever exposed).
- A `cortex serve` subcommand — Mesh spawns `node dist/index.js` with env; env
  vars are the config surface.
- Per-endpoint version negotiation / `/api/v2/` path prefixes — deferred until a
  second simultaneous contract version is actually needed.
- Reshaping existing payloads. v1 **ratifies the current wire shapes**; cleanup
  is a future coordinated v2.
- A published npm types package for Mesh — Mesh vendors the generated JSON
  Schema instead (see §10).

## 3. The consumer: Mesh (what shaped the design)

Mesh's locked decisions + actual code were read directly; they resolve choices we
would otherwise have guessed:

- **Mesh fetches from Node, not a browser.** The cortex bridge lives in
  `@mesh/core`, run in an Electron utility process (`packages/core/src/cortex/client.ts`
  uses Node `fetch` against `http://127.0.0.1:${port}`). **CORS never applies to
  Mesh** — the wildcard `*` only ever served Cortex's own browser `/viewer`. → we
  can lock CORS down with zero risk to Mesh.
- **Mesh spawns the sidecar itself** on a dynamic loopback port, passing env
  (`CORTEX_VIEWER_PORT`) — so `CORTEX_BIND_HOST` / `CORTEX_API_TOKEN` as env vars
  slot straight into its existing spawn (`packages/core/src/cortex/sidecar.ts`).
  Loopback-default bind matches its `127.0.0.1` assumption exactly.
- **The blind TTL is literally P6(b)'s reason to exist** — Mesh's `SubstrateClient`
  caches per-path with a 30 s timer and a blunt `refresh()` that clears
  everything, *because* the verdict isn't on the wire.
- **The client returns `unknown`** and reads fields ad hoc — so generated
  types/schemas are a consumer win, and reshaping any current field would break
  working Mesh M1.

## 4. Design

### §1 — Freshness over HTTP

**Two distinct signals, two mechanisms** (conflated if you only ship a header):

**(a) Cache validity ← the index baseline.** The served bytes change only when
the graph DB is republished (reindex). The baseline (`indexed_commit`,
`indexed_dirty_sig`, `indexed_at` in `cortex_index_meta`, read via
`readIndexMeta`) changes exactly then. That is the **ETag**:

```
ETag: "<contractVersion>:<project>:<sha256(indexed_commit|indexed_dirty_sig|indexed_at)>"
```

On every data endpoint, honor `If-None-Match` → **`304 Not Modified`** (empty
body) on a match. This upgrades Mesh's `SubstrateClient.get` from blind-TTL to
conditional revalidation: store the ETag with the cache entry, send
`If-None-Match`, keep cached data on 304 — no full-graph transfer on the common
"nothing changed" path.

**(b) Staleness signal ← the live verdict.** Whether the index is *behind the
working tree* is orthogonal to cache identity (a dirty tree doesn't change the
served graph until reindex). Reuse `freshnessForContext({ repoPath, graphDb,
canonical })` from `src/mcp-server/freshness.ts` (no new freshness logic),
surfaced two ways:

- **`X-Cortex-Freshness: <state>`** header on every `/api/*` response
  (`state ∈ fresh | stale:commits | stale:dirty | stale:both | empty | unknown`).
- **`GET /api/freshness?project=`** → the full `Freshness` JSON
  (`{ version, state, commits_behind?, dirty?, indexed_at?, note? }` — `note` is set
  on `unknown`/`empty` verdicts). Tiny, no graph
  pull — Mesh polls it cheaply; the post-commit auto-refresh republishes → ETag
  flips → Mesh's next conditional GET returns fresh data instead of 304.

**Project-scoped.** Both ETag and verdict are computed for the *resolved* project
(registry `root_path` + its graph DB + canonicity), mirroring how
`openProjectStore` resolves `/api/graph?project=`. Honors `CORTEX_FRESHNESS=0`
(verdict → `fresh`); the ETag is baseline-derived and works regardless.

### §2 — Contract & versioning

- **Contract version, not package version.** A single global integer, starting at
  `1`, independent of Cortex's semver — honors Mesh's D10 "no version/ABI
  coupling" (Mesh can assert "I speak contract v1" without coupling to `0.3.x`).
- **Sibling field, never an envelope wrap.** Mesh reads `res.nodes`,
  `res.decisions`, etc. directly; wrapping in `{ version, data }` would break it.
  `version` joins the existing top-level fields:

  ```jsonc
  GET /api/graph      → { "version": 1, "nodes": [...], "edges": [...], "project": "cortex" }
  GET /api/projects   → { "version": 1, "projects": [...], "active": "cortex" }
  GET /api/decisions  → { "version": 1, "decisions": [...] }
  GET /api/frames     → { "version": 1, "frames": [...], "stage": { "w": …, "h": … } }
  GET /api/file-edges → { "version": 1, "file_edges": [...] }
  GET /api/aggregates → { "version": 1, "aggregates": [...] }
  GET /api/freshness  → { "version": 1, "state": "fresh", "indexed_at": "…", … }
  GET /api/health     → { "version": 1, "ok": true }
  ```

  `GET /api/decisions/:id` is wrapped uniformly as `{ version, decision: {...} }`
  (a detail endpoint Mesh doesn't consume in M1 — the lone reshape is safe).
- Adding `version` is the **only** shape change to existing payloads; everything
  else is frozen as-is ("ratify, don't reshape").
- Also emit **`X-Cortex-API-Version: 1`** (inspectable without a body; survives a
  `304`). The body field is canonical; the header is convenience.
- In the schema, `version` is `z.literal(1)` — validation asserts the version.
- **Breaking-change path (documented, not built):** additive fields stay within
  v1; a removal/rename/retype bumps the global version to `2`; a `/api/v2/` path
  prefix is the deferred escape hatch for serving two versions at once.

### §3 — Zod schemas + response-validation posture (the "enforced" core)

- **Single source of truth:** `src/mcp-server/api-schemas.ts` exports a Zod schema
  per response and per request input. The hand-maintained TS interfaces are
  **replaced by `z.infer`** — type and validator are the same object;
  `api-decisions.ts` / `api-edges.ts` import their types from it.
- **Two boundaries, two postures:**

  | Boundary | Posture | On mismatch | Why |
  |---|---|---|---|
  | **Request inputs** (`project`, decision `id`, query params) | **Fail-closed, always** | `400 Bad Request` | Security boundary; cheap (tiny params). |
  | **Response outputs** | **Throw in test/CI; log-and-send in prod** | test → throw (CI fails); prod → `console.error` + send anyway | A response mismatch is a Cortex bug, not an attack; CI catches it; prod never 500s the user over our bug. `CORTEX_API_STRICT=1` forces strict prod for debugging. |

  Enforcement lives where it bites cheaply: inputs hard-enforced at runtime;
  outputs hard-enforced in the test suite + CI gate + the §5 drift guard.
- **The response helper** `respond(res, schema, data, ctx)` is the one chokepoint:
  validate (per posture) · `304` on `If-None-Match` · stamp `version` +
  `X-Cortex-Freshness` + `X-Cortex-API-Version` + `ETag` · serialize. Every
  handler routes through it, so cross-cutting concerns can't be forgotten on a
  new endpoint.
- **Perf:** output validation defaults **on** in all environments (low-ms over a
  few-thousand-node `/api/graph` on a local tool serving one client). Escape
  hatch if it ever bites: flip output validation to test-only; inputs stay
  always-on.

### §4 — Hardening middleware

A small chain of composable guards in front of the route handlers — not a
framework. Config is via **env vars** (matches how Mesh configures the sidecar).
All defaults are **inert for the local single-user case** — this adds locks you
opt into; it does not change Mesh's current behavior.

| # | Guard | Default (local) | Override | Fixes / behavior |
|---|---|---|---|---|
| 1 | Loopback bind | `127.0.0.1` | `CORTEX_BIND_HOST=0.0.0.0` | `listen(port)` → `listen(port, host)`. Closes LAN exposure. |
| 2 | Method gate | `GET` + `HEAD` | — | else `405`. `HEAD` supports cheap ETag revalidation; `OPTIONS` answered only for allowlisted origins. |
| 3 | CORS allowlist | no `Access-Control-*` (same-origin) | `CORTEX_CORS_ORIGINS=https://a,https://b` | Reflects `Origin` only if allowlisted. Browser `/viewer` is same-origin; Mesh is Node. |
| 4 | Bearer auth | **off** (`CORTEX_API_TOKEN` unset) | set `CORTEX_API_TOKEN` | else `401`; constant-time compare (`crypto.timingSafeEqual`). |
| 5 | Traversal guard | always on | — | `resolve(join(VIEWER_DIR, rel))` must stay under `VIEWER_DIR`+sep, else `404`. |
| 6 | Security headers | always on | — | Viewer HTML: `Content-Security-Policy` + `X-Frame-Options: DENY` + `Referrer-Policy: no-referrer`. All: `X-Content-Type-Options: nosniff`. |
| 7 | Limits | always on | — | `server.requestTimeout` + `headersTimeout`; reject non-GET bodies / oversized URLs. |

**Auth must NOT exempt `/api/projects`** — it returns `root_path` filesystem
paths (sensitive). Instead add a dedicated **unauthenticated `/api/health`** →
`{ version: 1, ok: true }` (no data), exempt only that, and switch Mesh's health
poll to it (see §10 cross-repo follow-up). Harmless while auth stays off.

**Ordering:** bind (server-level) → method → CORS → auth → route handler →
`respond()` stamps headers. Auth after CORS (so a preflight still answers), before
any data work.

### §5 — Docs generation + drift guard + cross-repo conformance

- **Generation:** `scripts/gen-api-schemas.ts` emits `docs/api/<endpoint>.schema.json`
  from the Zod schemas via **`zod-to-json-schema`** (added as a **devDependency** —
  generation is build/CI-only, never runtime; Zod 3 has no native export).
  npm script `gen:api-schemas`.
- **Drift guard (the teeth):** `tests/api/schema-drift.test.ts` regenerates
  in-memory and asserts byte-identity with the committed `docs/api/*.schema.json`.
  Change a schema without regenerating → CI fails. Same "output byte-identical,
  contract tests are the guard" pattern as the shared code-search engine
  (decision `D-qfz9`).
- **Live conformance:** per endpoint, an integration test spins the server,
  fetches, and validates the live response against its schema — proving the wire
  matches, not just the builders.
- **Cross-repo conformance:** the committed `docs/api/*.schema.json` is a shared,
  versioned artifact. Mesh's `fake-cortex.mjs` + `e2e/fixtures/dist/index.js`
  ("mimic cortex's viewer server contract") can vendor those schemas and assert
  their fakes conform — stopping the test doubles from silently diverging.

Three enforcement layers — request validation (runtime 400), response validation
(CI throw), schema-doc drift (CI byte-check) — plus a cross-repo anchor. The
contract can't rot without something going red.

### §6 — Module layout & the `api.ts` refactor

`startViewerServer` (today one 485-line `createServer` callback with an inline
`if (url.startsWith(...))` chain) is refactored so cross-cutting concerns are
centralized and un-forgettable. **Behavior is preserved** — the existing
`tests/api/` suite + new conformance tests are the guard.

**New modules** (small, single-purpose, independently testable):

| File | Responsibility |
|---|---|
| `src/mcp-server/api-schemas.ts` | Zod schemas + `z.infer` types — single source of truth. |
| `src/mcp-server/api-respond.ts` | `respond()` — validate, `304`, stamp version/freshness/etag headers, serialize. |
| `src/mcp-server/api-middleware.ts` | Guard chain: method, CORS, auth, security headers, traversal-safe static resolve, `bindHost()`. |
| `src/mcp-server/api-freshness.ts` | `httpFreshnessFor(project, store, registry)` → `{ verdict, etag }`. |
| `scripts/gen-api-schemas.ts` | Schema → `docs/api/*.schema.json` generator. |

**Route dispatch:** the inline chain becomes an ordered matcher table
(`[{ match, handler }, …]`) preserving today's order-sensitive routing
(`/api/decisions/` before `/api/decisions`; static fallback last). Each handler
shrinks to ~10–20 lines: resolve store → build data → `respond(...)` → cleanup in
`finally`. The 503/404/empty-store cases stay as today.

`startViewerServer` becomes an orchestrator: open registry → build route table →
`listen(port, CORTEX_BIND_HOST)` via the existing `bindWithRetry` → per request
run middleware (short-circuit on reject) → dispatch → `respond`. Bind-retry and
resource-cleanup discipline unchanged.

## 5. Endpoint reference (v1)

| Method | Path | Auth | Response (body) | Conditional |
|---|---|---|---|---|
| GET | `/api/health` | **exempt** | `{ version, ok }` | — |
| GET | `/api/freshness` | required* | `{ version, state, commits_behind?, dirty?, indexed_at? }` | — |
| GET | `/api/projects` | required* | `{ version, projects, active }` | ETag† |
| GET | `/api/graph` | required* | `{ version, nodes, edges, project }` | ETag / 304 |
| GET | `/api/frames` | required* | `{ version, frames, stage }` | ETag / 304 |
| GET | `/api/file-edges` | required* | `{ version, file_edges }` | ETag / 304 |
| GET | `/api/decisions` | required* | `{ version, decisions }` | ETag / 304 |
| GET | `/api/decisions/:id` | required* | `{ version, decision }` | ETag / 304 |
| GET | `/api/aggregates` | required* | `{ version, aggregates }` | ETag / 304 |

\* "required" only when `CORTEX_API_TOKEN` is set; off by default for local use.
† `/api/projects` reads the machine-wide registry, not a single project's index
baseline, so its ETag (if emitted) derives from registry state — it does **not**
participate in the graph-baseline `304` path that the per-project endpoints use.

## 6. Configuration (env reference)

| Var | Default | Effect |
|---|---|---|
| `CORTEX_VIEWER_PORT` | `3333` (plugin) / `3334` (dev) | Listen port (existing). |
| `CORTEX_BIND_HOST` | `127.0.0.1` | Bind interface. `0.0.0.0` to expose. |
| `CORTEX_API_TOKEN` | unset | When set, `/api/*` (except `/api/health`) requires `Authorization: Bearer`. |
| `CORTEX_CORS_ORIGINS` | unset (none) | Comma-separated allowlist of cross-origin browsers. |
| `CORTEX_API_STRICT` | unset | `1` → response validation fails closed (`500`) in prod too. |
| `CORTEX_FRESHNESS` | unset | `0` → verdict always `fresh` (existing). |

## 7. File inventory

**New:** `src/mcp-server/api-schemas.ts`, `api-respond.ts`, `api-middleware.ts`,
`api-freshness.ts`; `scripts/gen-api-schemas.ts`; `docs/api/*.schema.json` +
`docs/api/README.md`; `docs/architecture/http-api-contract.md`; tests under
`tests/api/` (schema-drift, respond, middleware, auth, cors, traversal, per-endpoint
conformance, freshness/etag/304).

**Changed:** `src/mcp-server/api.ts` (refactor to orchestrator + route table),
`api-decisions.ts` / `api-edges.ts` (types from `api-schemas.ts`), `src/index.ts`
(env passthrough), `package.json` (`zod-to-json-schema` devDep + `gen:api-schemas`
script + version bump), `README.md` / `TEST.md` (env vars),
`docs/architecture/graph-ui.md` (contract layer), `CLAUDE.md` (routing note),
`CHANGELOG.md`, `HANDOFF.md` (mark P6 shipped).

## 8. Testing strategy

- **Unit:** each Zod schema (valid/invalid fixtures); each middleware guard
  (method, CORS allowlist, auth pass/fail + constant-time, traversal escape);
  `respond()` (validate, 304, header stamping); `httpFreshnessFor` (verdict +
  ETag per state, project resolution).
- **Integration:** spin the server; per endpoint assert shape conforms to its
  schema, `version`/`X-Cortex-API-Version`/`X-Cortex-Freshness`/`ETag` present,
  `If-None-Match` → `304`, bad input → `400`, auth on → `401` without token / `200`
  with, `/api/health` exempt.
- **Drift guard:** committed JSON Schema == regenerated (byte-identical).
- **Gate 0 (visual QA):** the refactor touches the viewer server — start
  `npm run dev`, load `/viewer`, confirm it renders + switches projects with no
  console errors and the new headers present (per workflow.md Gate 0).
- Full suite stays green (currently 1131/1131).

## 9. Backward compatibility

The only payload change is the additive `version` field (+ the `:id` wrap, which
Mesh M1 doesn't consume). All defaults inert for local use. Mesh M1 continues to
work unchanged; it opts into freshness/ETag, auth, and version-checking on its own
schedule.

## 10. Cross-repo follow-ups (Mesh-side, tracked — not in this branch)

1. **Health-poll switch:** point `CortexSidecar.healthPoll` / `waitUntilUp` at
   `/api/health` instead of `/api/projects` (required before enabling auth; safe
   anytime).
2. **Conditional revalidation:** teach `SubstrateClient.get` to store the `ETag`
   and send `If-None-Match`, keeping cached data on `304` — replacing the blind
   TTL with verdict-keyed revalidation.
3. **Token passthrough (only when exposing):** set `CORTEX_API_TOKEN` in the
   sidecar spawn env and send `Authorization: Bearer` on all three fetch sites.
4. **Schema vendoring:** validate `fake-cortex.mjs` + `e2e/fixtures` responses
   against the vendored `docs/api/*.schema.json`; optionally adopt generated
   types to replace `unknown` in `client.ts`.

## 11. Documentation deliverable (first-class)

Per Cortex's standing rule that architectural work gets first-class docs + TSDoc,
and because new engineers must be able to understand and safely extend this
contract, the following are **part of the definition of done**, not optional:

- **`docs/architecture/http-api-contract.md`** — the onboarding doc. Covers: the
  single-source-of-truth model (Zod → types → JSON Schema), the request-vs-response
  validation postures, the middleware chain + ordering, the freshness/ETag
  two-signal model, the env-var config surface, the Mesh consumer contract, and —
  critically — the **maintenance workflow**: *how to add or change an endpoint
  without breaking the contract* (edit schema → regenerate docs → run drift guard
  → bump version on a breaking change). Include a worked "add an endpoint" example.
- **`docs/api/README.md`** — the consumer-facing reference (endpoints, fields,
  headers, `304`, auth, CORS, version) sitting beside the generated schemas.
- **TSDoc on every new module** (`api-schemas`, `api-respond`, `api-middleware`,
  `api-freshness`) and on the refactored `startViewerServer` — what it does, how to
  use it, what it depends on.
- **Updates to `docs/architecture/graph-ui.md`** (link the new contract layer) and
  **`CLAUDE.md`** (a short routing note: the HTTP contract is schema-governed; edit
  `api-schemas.ts` + regenerate, don't hand-edit `docs/api/*.json`).

## 12. Decision to capture

A `create_decision` governing the HTTP contract: *"Versioned, Zod-enforced HTTP
contract with freshness over HTTP and a hardened, opt-in-exposable surface."*
Rationale: single source of truth over docs-only schemas; consumer-driven
(Mesh); defense-in-depth for future non-local use. Alternatives: docs-only JSON
Schema (rejected — drifts), framework router (rejected — overkill for 7
endpoints), fail-closed response validation (rejected — runtime fragility).
`governs`: `src/mcp-server/api-schemas.ts`, `api.ts::startViewerServer`,
`docs/api/`.

## 13. Rollout & release sequencing

A code release: bump `package.json` / `plugin.json` /
`.claude-plugin/marketplace.json` + CHANGELOG entry, merged via PR with the CI
gate, per workflow.md. Gate 0 (visual QA) + Gate 1 (review) + Gate 2 (QA) apply.
**Version: minor — `0.4.0`** (confirmed: a new backward-compatible capability).

### Floating-entity (0.3.23) — already merged + rebased ✅

Update (2026-06-16): `feature/layout/floating-entity-placement` **merged to `main`**
(PR #23, `efc6799`, 0.3.23), and the P6 branch has been **rebased onto it**. Its base
now contains the merged `/api/aggregates` handler (`positionAggregates`, from
`src/mcp-server/aggregate-positioning.ts`) and the `Aggregate` shape with optional
`x`/`y`. The plan is written against that post-rebase base: the `/api/aggregates`
handler wraps the merged `positionAggregates` body in `respond()`, and `AggregateSchema`
includes `x`/`y`. No pre-release gate remains — implement P6 and release
**0.3.23 → 0.4.0** via PR + CI gate.

(History: this was originally a release-time gate because floating-entity was
unmerged; it landed mid-design, so the gate is satisfied and the rebase done.)
