# HTTP API Contract (v1)

> Onboarding doc for the Cortex viewer HTTP surface. If you are about to add,
> change, or consume one of the `/api/*` endpoints, read this first. The
> machine-readable schemas live beside this doc under
> [`docs/api/`](../api/README.md); they are **generated** — see
> [Single source of truth](#single-source-of-truth).

The Cortex sidecar serves a small HTTP surface that powers two consumers: the
built-in browser **frames viewer** (same-origin) and **Mesh**, which runs the
sidecar as a child process and fetches its data over loopback from Node. As of
contract **v1**, that surface is a **versioned, Zod-enforced, freshness-aware,
hardened contract** rather than a collection of hand-built `JSON.stringify`
responses. This document explains how it is structured, why, and — most
importantly — how to evolve it without breaking either consumer.

## Overview

Fifteen endpoints make up the contract. Two are operational (liveness +
freshness); three are write-only **ingest** routes for the show-your-work
pipeline (POST-only, method-gate carved out — see below); the other ten are
GET data endpoints the viewer and Mesh read.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Unauthenticated liveness probe — `{ version, ok: true }`, no data. |
| GET | `/api/freshness` | The live freshness verdict for a project (cheap, no graph pull). |
| POST | `/api/presence` | Presence-beacon ingest (hook-fed); `{ version, accepted }` ack, never an error status. |
| POST | `/api/show-focus` | Spotlight ingest for `show({action:"focus"})`; same `{ version, accepted }` ack shape as `/api/presence`. |
| POST | `/api/show-advance` | Story-paging ingest for `show({action:"advance"})`; same `{ version, accepted }` ack shape. |
| GET | `/api/projects` | The machine-wide registry of indexed projects + the active one. |
| GET | `/api/graph` | The full node/edge graph for a project. |
| GET | `/api/frames` | The frame map (clusters) + virtual-stage dimensions. |
| GET | `/api/file-edges` | File-to-file weighted edges (CALLS/USAGE/IMPORTS rollup). |
| GET | `/api/aggregates` | Positioned auxiliary-path aggregates (e.g. `locales`, `vendored`). |
| GET | `/api/decisions` | All decisions for a project, adapted for rendering. |
| GET | `/api/decisions/:id` | One decision by id. |
| GET | `/api/todos` | All TODOs for a project, adapted for rendering. |
| GET | `/api/stories` | All stories for a project (no steps), adapted for rendering. |
| GET | `/api/stories/:id` | One story + its steps, by canonical id (`S-xxxx`) or display seq. |

The three POST routes are a deliberate, narrow carve-out: the shared method
gate (below) is otherwise GET/HEAD-only, and each of these three is
special-cased past it (`isPresencePost` / `isShowFocusPost` /
`isShowAdvancePost` in `api.ts`) rather than widening the gate itself, so
every other route keeps its GET/HEAD-only contract. All three validate their
body against a dedicated Zod schema (`PresencePostSchema` /
`ShowFocusPostSchema` / `ShowAdvancePostSchema`), share the same
`MAX_PRESENCE_BODY` (16 KB) request cap, and gate on
`canonicalRepoPath(repo_path) === presence.homeRoot` — a repo/project
mismatch is `accepted: false`, never an error status. See
[show-your-work.md](show-your-work.md) for the event-bus wiring downstream
of each ack (`StoriesResponseSchema` / `StoryDetailResponseSchema` back the
two GET `/api/stories*` routes above; `ShowAdvanceAckResponseSchema` backs
the `/api/show-advance` ack).

Every response carries a top-level `version` field (currently `1`) as a
**sibling** of the data fields — never an `{ version, data }` envelope — so a
consumer that reads `res.nodes` or `res.decisions` directly keeps working.

**Mesh is the primary external consumer.** The cortex bridge lives in
`@mesh/core` and runs in an Electron utility process, using Node `fetch`
against `http://127.0.0.1:<port>`. Because Mesh fetches from Node and not from
a browser, **CORS never applies to it** — the CORS allowlist (below) exists only
for Cortex's own browser `/viewer`, and Mesh pays nothing for it being locked
down by default. The browser viewer is same-origin, so it needs no CORS either.

## Single source of truth

There is exactly one place a response shape is defined:
[`src/mcp-server/api-schemas.ts`](../../src/mcp-server/api-schemas.ts). It
exports **one Zod schema per response**. Everything else is derived from it:

```
                  ┌─────────────────────────────┐
                  │  api-schemas.ts (Zod)        │  ← edit HERE
                  │  GraphResponseSchema, …       │
                  └──────────┬──────────┬─────────┘
                             │          │
              z.infer<…>     │          │   scripts/gen-api-schemas.ts
              (TS types)     │          │   (zod-to-json-schema)
                             ▼          ▼
        export type GraphResponse   docs/api/*.schema.json
        (used by api.ts, Mesh)      (generated artifact, drift-guarded)
```

- The **TypeScript types** are `z.infer<typeof …Schema>` — the validator and the
  type are the same object, so they can never disagree. `api-decisions.ts` and
  `api-edges.ts` import their boundary types (`AdaptedDecision`, `FileEdge`,
  `GovernsRef`, …) from here.
- The **JSON Schema docs** under [`docs/api/`](../api/) are produced by
  `scripts/gen-api-schemas.ts` via `zod-to-json-schema`, keyed off the
  `RESPONSE_SCHEMAS` registry at the bottom of `api-schemas.ts`.

**Never hand-edit `docs/api/*.schema.json`.** Those files are output, not input.
The drift-guard test ([`tests/api/schema-drift.test.ts`](../../tests/api/schema-drift.test.ts))
regenerates the schemas in memory and asserts byte-for-byte equality with the
committed JSON; if you edit a Zod schema without running
`npm run gen:api-schemas`, or hand-edit the JSON, CI fails.

The contract version is the constant `CONTRACT_VERSION = 1` in `api-schemas.ts`.
It is a **contract** version, deliberately independent of the Cortex package
semver — a consumer can assert "I speak contract v1" without coupling to
`0.x.y`. In each schema the field is `z.literal(1)`, so validation also asserts
the version.

v1 follows a **"ratify, don't reshape"** rule: the schemas freeze the *current*
wire output. They mirror the existing internal shapes (`NodeRow`/`EdgeRow` from
`src/graph/store.ts`, `IndexerProject`, `FrameMapEntry`, `FileEdge`,
`Aggregate`, `AdaptedDecision`) rather than improving them. Genuinely evolving
fields — `frame.layer` (a string, though the internal `FrameLayer` union may
grow) and `decision.provenance` (a permissive record, not the narrow
`ProvenanceMeta`) — use deliberately loose Zod so an additive change stays
inside v1. Any *reshape* (rename/remove/retype) is a v2 concern.

## Validation postures

The contract enforces validation at **two boundaries with two different
postures**, because they are two different kinds of risk.

**Request inputs — fail-closed, always `400`.** The shared `?project=` query
param and the decision `:id` path param are validated with
`ProjectParamSchema` / `DecisionIdParamSchema` before any work happens. A bad
input is a (potential) abuse vector and the params are tiny, so validation is
cheap and always on; on failure the handler returns `400 Bad Request` and does
no further work.

**Response outputs — throw in test/CI, log-and-send in prod.** Every response is
`safeParse`d against its schema inside `respond()`. On a mismatch:

- In **test/CI** (or when `CORTEX_API_STRICT=1`), `respond()` **throws** — the
  test fails, the CI gate goes red, and the bug is caught before release.
- In **production**, it logs `console.error("[cortex api] response schema
  mismatch (sent anyway): …")` and **sends the payload anyway**.

The asymmetry is intentional. A response that doesn't match its schema is a
**Cortex bug, not an attack** — the bytes came from our own builders. The right
place to catch our bug is the test suite + CI, where it's loud and free. In
production, failing closed (500) would take the viewer down over *our* mistake,
which is worse for the user than serving slightly-off-but-usable data. The
`CORTEX_API_STRICT=1` escape hatch lets you reproduce strict behavior in prod
when you actively want to debug a mismatch.

`isStrict()` in `api-respond.ts` is the single predicate: true when
`CORTEX_API_STRICT=1`, `VITEST=true`, or `NODE_ENV=test`.

## The `respond()` chokepoint

[`respond(res, schema, data, ctx)`](../../src/mcp-server/api-respond.ts) is the
**one** function every data handler calls to send a response. Routing everything
through it means the cross-cutting concerns can't be forgotten when a new
endpoint is added. In one call it:

1. **Validates** `data` against `schema` per the response posture above.
2. Honors **`If-None-Match` → `304 Not Modified`** (empty body) when the
   request's `If-None-Match` equals the computed `ETag`.
3. Stamps the standard headers: `X-Cortex-API-Version`, `X-Cortex-Freshness`,
   `ETag`, and `X-Content-Type-Options: nosniff` (plus any extra headers such as
   CORS passed in `ctx.headers`).
4. Sends **no body for `HEAD`** (headers only, including `ETag`) — so a consumer
   can revalidate a cache with a `HEAD` request — and serializes JSON otherwise.

Its small sibling `respondError(res, status, message, headers)` handles the
4xx/5xx paths (`400`/`401`/`404`/`405`/`414`/`503`). It does **not** run schema
validation — error bodies are a fixed `{ error: message }` shape — but it still
stamps `nosniff`.

The rule for new endpoints: **build your data object, then `respond(...)` it.**
Never `res.writeHead(200, …); res.end(JSON.stringify(...))` by hand — that
bypasses validation, versioning, ETag/304, and HEAD handling.

## Freshness — the two-signal model

Cortex serves a *derived* graph (the index), so "is this fresh?" has two
genuinely different answers, and the contract surfaces both with two different
mechanisms. Conflating them into a single header would be wrong. Both are
implemented in [`api-freshness.ts`](../../src/mcp-server/api-freshness.ts).

**Signal A — cache identity (the `ETag`).** The bytes a data endpoint serves
change only when the graph DB is **republished** (a reindex). The index
*baseline* (`indexed_commit`, `indexed_dirty_sig`, `indexed_at`, read via
`readIndexMeta`) changes at exactly that moment and at no other. So `computeEtag`
hashes that baseline into a strong validator:

```
ETag: "<etagVersion>:<project>:<sha256(indexed_commit|indexed_dirty_sig|indexed_at)[:32]>"
```

This is the right `If-None-Match` target: a consumer stores the `ETag` with its
cached copy, sends `If-None-Match: <etag>` on the next request, and gets a cheap
**`304`** (no full-graph transfer) whenever nothing has been reindexed. When a
reindex republishes the graph, the baseline changes, the ETag flips, and the
next conditional GET returns the new data with `200` instead of `304`.

**Signal B — staleness verdict (the `X-Cortex-Freshness` header +
`/api/freshness`).** Whether the index is *behind the working tree* is
orthogonal to cache identity — a dirty tree does **not** change the served graph
until you reindex. `httpFreshnessFor` reuses the existing
`freshnessForContext({ repoPath, graphDb, canonical })` (no new freshness logic)
to compute the live verdict, surfaced two ways:

- `X-Cortex-Freshness: <state>` on every `/api/*` response, where `state ∈
  fresh | stale:commits | stale:dirty | stale:both | empty | unknown`.
- `GET /api/freshness?project=` returns the full verdict as JSON:
  `{ version, state, commits_behind?, dirty?, indexed_at?, note? }`. It pulls no
  graph data, so a consumer can poll it cheaply. The optional `note` is set on
  the `unknown`/`empty` verdicts (e.g. "project not in registry — freshness
  unavailable").

Both signals are **project-scoped**: the ETag and the verdict are computed for
the *resolved* project (its registry `root_path`, its graph DB, and its
canonicity), mirroring how `openProjectStore` resolves `?project=`. The verdict
honors `CORTEX_FRESHNESS=0` (forces `fresh`); the ETag is baseline-derived and
works regardless of that flag.

How the signals work together for a consumer like Mesh: poll `/api/freshness`
cheaply to know whether to *prompt* a reindex; use `ETag`/`If-None-Match`/`304`
to *revalidate* cached data without re-transferring it. After Cortex's
post-commit auto-refresh republishes the graph, the ETag flips and the
consumer's next conditional GET returns fresh data.

> Note: `/api/projects` reads the machine-wide registry, not a single project's
> index baseline, so it does not participate in the per-project graph-baseline
> `304` path the data endpoints use. It still carries `X-Cortex-API-Version` and
> `X-Cortex-Freshness`.

## Hardening middleware

A small chain of composable guards runs in front of the route table — not a
framework, just pure functions in
[`api-middleware.ts`](../../src/mcp-server/api-middleware.ts) that
`startViewerServer` composes per request. **Every default is inert for the local
single-user case**: this adds locks you opt into, and changes nothing about
Mesh's current behavior.

The per-request order in `api.ts` is:

1. **Oversized request-target → `414`.** `urlTooLong` rejects any request URL
   longer than `MAX_URL_LENGTH` (2048) — a cheap abuse limit.
2. **CORS preflight (`OPTIONS`).** Answered with `204` + CORS headers **only**
   for an allowlisted origin; otherwise `405`. (`corsHeadersFor` returns `{}`
   for any non-allowlisted origin, so no `Access-Control-*` is ever reflected by
   default.)
3. **Method gate → `405`.** Only `GET` and `HEAD` are allowed (`methodAllowed`).
4. **Bearer auth → `401`** for `/api/*` paths when a token is configured
   (`checkAuth`, constant-time compare via `crypto.timingSafeEqual`). The static
   viewer is public; `/api/health` is the only auth-exempt endpoint.

Auth is checked *after* CORS so a browser preflight still answers, and *before*
any data work so an unauthorized request never touches the store. Two more
always-on guards live outside that ordered chain: `safeStaticPath` (traversal
guard — a resolved static path must stay under `VIEWER_DIR`, else `404`) and
`SECURITY_HEADERS` (`Content-Security-Policy`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `nosniff`) on served viewer documents/assets.
The server also sets `requestTimeout` (30 s) and `headersTimeout` (35 s).

`/api/health` is the **only** member of `AUTH_EXEMPT`. `/api/projects` is
**deliberately not exempt** — it returns `root_path` filesystem paths, which are
sensitive — which is why a dedicated, data-free `/api/health` exists for
liveness probing.

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `CORTEX_VIEWER_PORT` | `3333` (plugin) / `3334` (dev) | Listen port. |
| `CORTEX_BIND_HOST` | `127.0.0.1` | Bind interface; set `0.0.0.0` to deliberately expose on the LAN. |
| `CORTEX_API_TOKEN` | unset | When set, every `/api/*` path except `/api/health` requires `Authorization: Bearer <token>`. |
| `CORTEX_CORS_ORIGINS` | unset | Comma-separated browser-origin allowlist; only an allowlisted `Origin` is reflected. |
| `CORTEX_API_STRICT` | unset | `1` → response-validation failures return `500` in production too (otherwise log + send). |
| `CORTEX_FRESHNESS` | unset | `0` → the freshness verdict is always `fresh` (the ETag is unaffected). |

## Mesh consumer contract

Mesh shaped this design and is its primary external consumer. The relevant facts:

- **Node fetch, no CORS.** Mesh's cortex bridge (`@mesh/core`) runs in an
  Electron utility process and uses Node `fetch` against
  `http://127.0.0.1:<port>`. CORS is a browser mechanism, so it never applies to
  Mesh — which is why locking the CORS allowlist down by default costs Mesh
  nothing.
- **Mesh spawns the sidecar.** Mesh launches `node dist/index.js` on a dynamic
  loopback port and passes configuration as **env vars** (e.g.
  `CORTEX_VIEWER_PORT`). The loopback-default bind matches its `127.0.0.1`
  assumption exactly, and `CORTEX_BIND_HOST` / `CORTEX_API_TOKEN` slot straight
  into that existing spawn when Mesh ever wants to expose or lock the surface.

**Tracked cross-repo follow-ups (Mesh-side, not in this branch):**

1. **Health-poll switch** — point Mesh's sidecar health poll / `waitUntilUp` at
   `/api/health` instead of `/api/projects` (required before enabling auth, safe
   anytime, since `/api/projects` is no longer auth-exempt).
2. **Conditional revalidation** — teach Mesh's `SubstrateClient.get` to store the
   `ETag` and send `If-None-Match`, keeping cached data on a `304`. This replaces
   its current **blind 30 s TTL** with verdict-keyed revalidation (the original
   reason this contract work exists).
3. **Token passthrough (only when exposing)** — set `CORTEX_API_TOKEN` in the
   sidecar spawn env and send `Authorization: Bearer` on Mesh's fetch sites.
4. **Schema vendoring** — vendor the committed `docs/api/*.schema.json` into
   Mesh's `fake-cortex` mock and `e2e` fixtures and validate those test doubles
   against them, so the fakes can't silently diverge from the real contract.
   Optionally adopt the generated types to replace `unknown` in Mesh's client.

## Maintenance workflow — how to add or change an endpoint without breaking the contract

The contract is designed so that the *correct* way to change it is also the
*easy* way, and any shortcut trips a red test. The workflow:

```
1. Add/edit the Zod schema in src/mcp-server/api-schemas.ts
   (+ register it in the RESPONSE_SCHEMAS map).
2. Wire the handler in api.ts through respond(res, <Schema>, <data>, freshCtx()).
3. Run `npm run gen:api-schemas` to regenerate docs/api/*.schema.json.
4. Run `npx vitest run tests/api/` — the drift guard + conformance tests must pass.
5. Breaking change (remove/rename/retype a field)? Bump CONTRACT_VERSION → 2.
```

An **additive** field (a new optional property) stays within v1. A **breaking**
change — removing, renaming, or retyping an existing field — bumps
`CONTRACT_VERSION`. (Serving two versions at once via an `/api/v2/` path prefix
is the deferred escape hatch; it is not built yet, and shouldn't be until a
second live version is actually needed.)

### Worked example: add `GET /api/stats`

Suppose we want a new endpoint returning `{ version, node_count }`.

**Step 1 — add the schema** in `src/mcp-server/api-schemas.ts`:

```ts
export const StatsResponseSchema = z.object({
  version: Version,
  node_count: z.number(),
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;
```

and register it in `RESPONSE_SCHEMAS` so the generator + drift guard pick it up:

```ts
export const RESPONSE_SCHEMAS = {
  // …existing entries…
  stats: StatsResponseSchema,
} as const;
```

**Step 2 — wire the handler** in `api.ts` (import `StatsResponseSchema`, then add
a route ahead of the static fallback):

```ts
// ── /api/stats ──
if (pathname === "/api/stats") {
  const resolved = openProjectStore(store, indexerProject, project, { registry });
  const node_count = resolved
    ? resolved.store.getAllNodesUnified(project ?? undefined).length
    : 0;
  try {
    respond(res, StatsResponseSchema,
      { version: CONTRACT_VERSION, node_count }, freshCtx());
  } finally {
    if (resolved?.owned) resolved.store.close();
  }
  return;
}
```

`freshCtx()` is the per-request helper already in scope — it computes the
verdict + ETag for the resolved project and carries the request and any CORS
headers, so the new endpoint gets versioning, freshness, ETag/304, and
HEAD handling for free.

**Step 3 — regenerate the schema doc:**

```bash
npm run gen:api-schemas      # writes docs/api/stats.schema.json
```

**Step 4 — run the API tests:**

```bash
npx vitest run tests/api/    # drift guard + conformance must be green
```

`StatsResponseSchema` uses only additive fields, so this stays contract v1. If
you later removed or retyped `node_count`, you would bump `CONTRACT_VERSION` to
`2` (step 5) — and the `version` literal in every schema would assert the new
value.

## Related modules

| File | Responsibility |
|---|---|
| [`api-schemas.ts`](../../src/mcp-server/api-schemas.ts) | Zod schemas + `z.infer` types + `RESPONSE_SCHEMAS` — the single source of truth. |
| [`api-respond.ts`](../../src/mcp-server/api-respond.ts) | `respond()` / `respondError()` chokepoint: validate, `304`, header stamping, HEAD, serialize. |
| [`api-freshness.ts`](../../src/mcp-server/api-freshness.ts) | `computeEtag()` (baseline validator) + `httpFreshnessFor()` (live verdict + ETag). |
| [`api-middleware.ts`](../../src/mcp-server/api-middleware.ts) | Guard chain: bind host, method gate, URL limit, CORS, bearer auth, traversal-safe static, security headers. |
| [`api.ts`](../../src/mcp-server/api.ts) | `startViewerServer` — orchestrates registry → middleware chain → route table → `respond()`. |
| [`scripts/gen-api-schemas.ts`](../../scripts/gen-api-schemas.ts) | Generates `docs/api/*.schema.json` from `RESPONSE_SCHEMAS`. |
| [`docs/api/README.md`](../api/README.md) | The consumer-facing endpoint/header/field reference. |
