# Versioned, Zod-Enforced HTTP Contract + Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Cortex's seven viewer HTTP endpoints into a versioned, Zod-enforced, freshness-aware, hardened contract — one Zod schema per response as the single source of truth (runtime validation + `z.infer` types + generated JSON Schema docs), `X-Cortex-Freshness`/ETag conditional revalidation, and a defense-in-depth middleware layer (loopback bind, traversal guard, CORS allowlist, method gate, opt-in bearer auth, security headers).

**Architecture:** A `respond()` chokepoint validates every JSON payload, stamps `version` + freshness + ETag headers, and emits `304` on `If-None-Match`. A composable middleware chain (method → CORS → auth) fronts an ordered route table inside the refactored `startViewerServer`. Schemas live in one module; a generator emits `docs/api/*.schema.json` and a drift-guard test keeps them byte-identical to the Zod source. Reuses the existing `freshnessForContext` machinery; all hardening defaults are inert for the local single-user case.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Zod `^3.24.4`, `zod-to-json-schema` (devDep), `node:http`, `node:crypto`, `better-sqlite3`, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-16-versioned-http-contract-hardening-design.md](../specs/2026-06-16-versioned-http-contract-hardening-design.md)

---

## Pre-flight: branch & base

- Work happens in worktree `../cortex-wt-api-contract` on branch
  `feature/api/versioned-contract-hardening`.
- **Floating-entity (0.8.23) is already MERGED to `main`** (PR #23, `efc6799`) and this
  branch has been **rebased onto it**. Its base now contains the merged `/api/aggregates`
  handler (`positionAggregates`, from `src/mcp-server/aggregate-positioning.ts`, already
  imported in `api.ts`) and the `Aggregate` shape with optional `x`/`y`. The plan below is
  written against that post-rebase base: Task 6's `/api/aggregates` handler wraps the
  merged `positionAggregates` body in `respond()` (do NOT revert to `groupAuxiliaryPaths`),
  and Task 2's `AggregateSchema` includes `x`/`y`. The release is **0.8.23 → 0.9.0** (minor).

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/mcp-server/api-schemas.ts` | **new** — Zod schemas + `z.infer` types (single source of truth) | 2 |
| `src/mcp-server/api-freshness.ts` | **new** — `httpFreshnessFor()` + `computeEtag()` | 3 |
| `src/mcp-server/api-respond.ts` | **new** — `respond()` / `respondError()` chokepoint | 4 |
| `src/mcp-server/api-middleware.ts` | **new** — method/CORS/auth guards, `safeStaticPath`, `resolveBindHost` | 5 |
| `src/mcp-server/api.ts` | **modify** — route table + middleware + new endpoints + bind host | 6 |
| `src/mcp-server/api-decisions.ts` | **modify** — import types from `api-schemas.ts` | 2 |
| `src/mcp-server/api-edges.ts` | **modify** — import `FileEdge` type from `api-schemas.ts` | 2 |
| `scripts/gen-api-schemas.ts` | **new** — Zod → `docs/api/*.schema.json` generator | 7 |
| `docs/api/*.schema.json` + `docs/api/README.md` | **new** — generated schemas + consumer reference | 7, 9 |
| `docs/architecture/http-api-contract.md` | **new** — onboarding doc | 9 |
| `tests/api/*.test.ts` | **new** — schema, freshness, respond, middleware, conformance, drift | 2–8 |
| `package.json` | **modify** — devDep + `gen:api-schemas` script | 1 |
| `README.md` / `TEST.md` / `docs/architecture/graph-ui.md` / `CLAUDE.md` | **modify** — env vars + contract-layer docs | 9 |

---

## Task 1: Add `zod-to-json-schema` + npm script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the devDependency**

Run (in the worktree root):
```bash
npm install --save-dev zod-to-json-schema@^3.24.1
```
Expected: `package.json` gains `"zod-to-json-schema"` under `devDependencies`; `package-lock.json` updated.

- [ ] **Step 2: Add the generator script to `package.json`**

In `package.json` `"scripts"`, add after the `"test"` line:
```json
    "gen:api-schemas": "tsx scripts/gen-api-schemas.ts",
```

- [ ] **Step 3: Verify**

Run: `node -e "require('zod-to-json-schema')" && echo OK`
Expected: prints `OK` (module resolves).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(api): add zod-to-json-schema devDep + gen:api-schemas script"
```

---

## Task 2: Contract schemas (`api-schemas.ts`)

Single source of truth. Ratifies the **current** wire shapes (`NodeRow`, `EdgeRow`+aliases, `IndexerProject`, `FrameMapEntry`, `FileEdge`, `Aggregate`, `AdaptedDecision`). Loose/evolving fields (`layer`, `provenance`) use forward-compatible Zod so additive changes stay in v1.

**Files:**
- Create: `src/mcp-server/api-schemas.ts`
- Test: `tests/api/api-schemas.test.ts`
- Modify: `src/mcp-server/api-decisions.ts`, `src/mcp-server/api-edges.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/api-schemas.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  CONTRACT_VERSION,
  GraphResponseSchema,
  ProjectsResponseSchema,
  FramesResponseSchema,
  FileEdgesResponseSchema,
  AggregatesResponseSchema,
  DecisionsResponseSchema,
  DecisionDetailResponseSchema,
  FreshnessResponseSchema,
  HealthResponseSchema,
  ProjectParamSchema,
  DecisionIdParamSchema,
} from "../../src/mcp-server/api-schemas.js";

describe("api-schemas", () => {
  it("CONTRACT_VERSION is 1", () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  it("GraphResponseSchema accepts a current-shape payload", () => {
    const ok = GraphResponseSchema.safeParse({
      version: 1,
      nodes: [{ id: "n1", kind: "function", name: "f", qualified_name: "m::f", file_path: "a.ts", data: "{}", tier: "code", created_at: "t", updated_at: "t" }],
      edges: [{ id: "e1", source_id: "n1", target_id: "n2", relation: "CALLS", data: "{}", created_at: "t", source: "n1", target: "n2" }],
      project: "cortex",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects wrong version", () => {
    const bad = GraphResponseSchema.safeParse({ version: 2, nodes: [], edges: [], project: null });
    expect(bad.success).toBe(false);
  });

  it("HealthResponseSchema requires ok:true", () => {
    expect(HealthResponseSchema.safeParse({ version: 1, ok: true }).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ version: 1, ok: false }).success).toBe(false);
  });

  it("FreshnessResponseSchema accepts a verdict", () => {
    expect(FreshnessResponseSchema.safeParse({ version: 1, state: "fresh", indexed_at: "t" }).success).toBe(true);
    expect(FreshnessResponseSchema.safeParse({ version: 1, state: "nope" }).success).toBe(false);
  });

  it("ProjectsResponseSchema + FramesResponseSchema + AggregatesResponseSchema + FileEdgesResponseSchema accept current shapes", () => {
    expect(ProjectsResponseSchema.safeParse({ version: 1, projects: [{ name: "c", indexed_at: "t", root_path: "/r" }], active: "c" }).success).toBe(true);
    expect(FramesResponseSchema.safeParse({ version: 1, frames: [{ id: 1, name: "F", count: 3, x: 0, y: 0, w: 1, h: 1, ambient: true, rank: 0, score: 1, layer: "domain" }], stage: { w: 800, h: 600 } }).success).toBe(true);
    expect(AggregatesResponseSchema.safeParse({ version: 1, aggregates: [{ id: "aux:dist:x", label: "x", aux_segment: "dist", member_count: 2, sample_paths: ["dist/x/a.js"], x: 120, y: 340 }] }).success).toBe(true);
    expect(FileEdgesResponseSchema.safeParse({ version: 1, file_edges: [{ from_path: "a.ts", to_path: "b.ts", weight: 3 }] }).success).toBe(true);
  });

  it("DecisionsResponseSchema + detail accept an adapted decision", () => {
    const dec = { id: "D-1", seq: 1, summary: "s", state: "active", problem: null, resolution: null, rationale: "r", alternatives: [{ title: "a", reason: "b" }], proposedBy: "x", proposedAt: "t", governs: [{ kind: "file", path: "a.ts" }], supersedes: null, supersededBy: null, relatedTo: [], dependsOn: [], provenance: null };
    expect(DecisionsResponseSchema.safeParse({ version: 1, decisions: [dec] }).success).toBe(true);
    expect(DecisionDetailResponseSchema.safeParse({ version: 1, decision: dec }).success).toBe(true);
  });

  it("request param schemas reject empty / overlong", () => {
    expect(ProjectParamSchema.safeParse(undefined).success).toBe(true);
    expect(ProjectParamSchema.safeParse("").success).toBe(false);
    expect(DecisionIdParamSchema.safeParse("D-1").success).toBe(true);
    expect(DecisionIdParamSchema.safeParse("").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/api/api-schemas.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp-server/api-schemas.js'`.

- [ ] **Step 3: Write `api-schemas.ts`**

Create `src/mcp-server/api-schemas.ts`:
```ts
/**
 * Single source of truth for the Cortex HTTP API contract (v1).
 *
 * Each response is a Zod schema; the TypeScript type is `z.infer` of it, and the
 * JSON Schema docs under `docs/api/` are GENERATED from these (see
 * scripts/gen-api-schemas.ts). Never hand-edit the JSON — edit here and run
 * `npm run gen:api-schemas`. The drift-guard test (tests/api/schema-drift.test.ts)
 * fails CI if the committed JSON diverges from these schemas.
 *
 * Shapes RATIFY the current wire output ("freeze, don't reshape"): they mirror
 * NodeRow/EdgeRow (src/graph/store.ts), IndexerProject (src/graph/code-queries.ts),
 * FrameMapEntry (src/mcp-server/frame-map.ts), FileEdge (src/mcp-server/api-edges.ts),
 * Aggregate (src/frame-extraction/auxiliary-detection.ts) and AdaptedDecision.
 * Genuinely evolving fields (`layer`, `provenance`) use permissive Zod so an
 * additive change stays inside contract v1.
 */
import { z } from "zod";

/** Global contract version — independent of the Cortex package semver. */
export const CONTRACT_VERSION = 1 as const;
const Version = z.literal(CONTRACT_VERSION);

// ── Graph ────────────────────────────────────────────────────────────────────
/** Mirrors NodeRow (src/graph/store.ts). */
export const NodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  qualified_name: z.string().nullable(),
  file_path: z.string().nullable(),
  data: z.string(),
  tier: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
/** Mirrors EdgeRow + the viewer `source`/`target` aliases the handler adds. */
export const EdgeSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  target_id: z.string(),
  relation: z.string(),
  data: z.string(),
  created_at: z.string(),
  source: z.string(),
  target: z.string(),
});
export const GraphResponseSchema = z.object({
  version: Version,
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  project: z.string().nullable(),
});
export type GraphResponse = z.infer<typeof GraphResponseSchema>;

// ── Projects ───────────────────────────────────────────────────────────────
/** Mirrors IndexerProject (src/graph/code-queries.ts). */
export const ProjectSchema = z.object({
  name: z.string(),
  indexed_at: z.string(),
  root_path: z.string(),
});
export const ProjectsResponseSchema = z.object({
  version: Version,
  projects: z.array(ProjectSchema),
  active: z.string().nullable(),
});
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

// ── Frames ───────────────────────────────────────────────────────────────────
/** Mirrors FrameMapEntry (src/mcp-server/frame-map.ts). `layer` is a plain
 *  string on purpose — the FrameLayer union may grow without breaking v1. */
export const FrameSchema = z.object({
  id: z.number(),
  name: z.string(),
  count: z.number(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  ambient: z.boolean(),
  rank: z.number(),
  score: z.number(),
  layer: z.string(),
});
export const StageSchema = z.object({ w: z.number(), h: z.number() });
export const FramesResponseSchema = z.object({
  version: Version,
  frames: z.array(FrameSchema),
  stage: StageSchema,
});
export type FramesResponse = z.infer<typeof FramesResponseSchema>;

// ── File edges ─────────────────────────────────────────────────────────────
/** Mirrors FileEdge (src/mcp-server/api-edges.ts). */
export const FileEdgeSchema = z.object({
  from_path: z.string(),
  to_path: z.string(),
  weight: z.number(),
});
export const FileEdgesResponseSchema = z.object({
  version: Version,
  file_edges: z.array(FileEdgeSchema),
});
export type FileEdgesResponse = z.infer<typeof FileEdgesResponseSchema>;

// ── Aggregates ─────────────────────────────────────────────────────────────
/** Mirrors Aggregate (src/frame-extraction/auxiliary-detection.ts). `x`/`y` are
 *  the virtual-stage center px set by positionAggregates for placed aggregates
 *  (absent for unplaced) — they MUST be in the schema or the generated doc
 *  under-describes the real wire shape Mesh + the viewer receive. */
export const AggregateSchema = z.object({
  id: z.string(),
  label: z.string(),
  aux_segment: z.string(),
  member_count: z.number(),
  sample_paths: z.array(z.string()),
  x: z.number().optional(),
  y: z.number().optional(),
});
export const AggregatesResponseSchema = z.object({
  version: Version,
  aggregates: z.array(AggregateSchema),
});
export type AggregatesResponse = z.infer<typeof AggregatesResponseSchema>;

// ── Decisions ────────────────────────────────────────────────────────────────
export const GovernsRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frame"), id: z.string(), label: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("function"), path: z.string(), name: z.string() }),
  z.object({ kind: z.literal("symbol"), path: z.string(), name: z.string() }),
]);
export const AdaptedAlternativeSchema = z.object({ title: z.string(), reason: z.string() });
/** Mirrors AdaptedDecision (src/mcp-server/api-decisions.ts). `provenance` is
 *  free-form nested JSON, kept permissive. */
export const AdaptedDecisionSchema = z.object({
  id: z.string(),
  seq: z.number().nullable(),
  summary: z.string(),
  state: z.string(),
  problem: z.string().nullable(),
  resolution: z.string().nullable(),
  rationale: z.string(),
  alternatives: z.array(AdaptedAlternativeSchema),
  proposedBy: z.string().nullable(),
  proposedAt: z.string(),
  governs: z.array(GovernsRefSchema),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  relatedTo: z.array(z.string()),
  dependsOn: z.array(z.string()),
  provenance: z.record(z.unknown()).nullable(),
});
export type AdaptedDecision = z.infer<typeof AdaptedDecisionSchema>;
export type GovernsRef = z.infer<typeof GovernsRefSchema>;
export type AdaptedAlternative = z.infer<typeof AdaptedAlternativeSchema>;

export const DecisionsResponseSchema = z.object({
  version: Version,
  decisions: z.array(AdaptedDecisionSchema),
});
export const DecisionDetailResponseSchema = z.object({
  version: Version,
  decision: AdaptedDecisionSchema,
});

// ── Freshness + health ───────────────────────────────────────────────────────
export const FreshnessStateSchema = z.enum([
  "fresh", "stale:commits", "stale:dirty", "stale:both", "empty", "unknown",
]);
export const FreshnessResponseSchema = z.object({
  version: Version,
  state: FreshnessStateSchema,
  commits_behind: z.number().optional(),
  dirty: z.boolean().optional(),
  indexed_at: z.string().optional(),
  note: z.string().optional(),
});
export type FreshnessResponse = z.infer<typeof FreshnessResponseSchema>;

export const HealthResponseSchema = z.object({ version: Version, ok: z.literal(true) });

// ── Request inputs (fail-closed → 400) ───────────────────────────────────────
export const ProjectParamSchema = z.string().min(1).max(200).optional();
export const DecisionIdParamSchema = z.string().min(1).max(200);

/** Registry of response schemas keyed by the doc filename stem — drives the
 *  generator (Task 7) and the drift guard. */
export const RESPONSE_SCHEMAS = {
  graph: GraphResponseSchema,
  projects: ProjectsResponseSchema,
  frames: FramesResponseSchema,
  "file-edges": FileEdgesResponseSchema,
  aggregates: AggregatesResponseSchema,
  decisions: DecisionsResponseSchema,
  "decision-detail": DecisionDetailResponseSchema,
  freshness: FreshnessResponseSchema,
  health: HealthResponseSchema,
} as const;
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `npx vitest run tests/api/api-schemas.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Point `api-decisions.ts` / `api-edges.ts` at the inferred types**

In `src/mcp-server/api-decisions.ts`, **delete** the `GovernsRef`, `AdaptedAlternative`, and `AdaptedDecision` interface declarations and replace the top of the file's type exports with a re-export from the schema module:
```ts
// Types now derive from the Zod single source of truth (api-schemas.ts).
export type { GovernsRef, AdaptedAlternative, AdaptedDecision } from "./api-schemas.js";
```
(Keep the `FrameInfo` interface — it is internal, not part of the wire contract.)

In `src/mcp-server/api-edges.ts`, **delete** the `FileEdge` interface and replace with:
```ts
export type { FileEdge } from "./api-schemas.js";
```
Keep `BuildFileEdgesOptions` and the `buildFileEdges` implementation unchanged.

- [ ] **Step 6: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: exit 0. The inferred types are structurally **compatible** with the deleted interfaces. One deliberate widening: `provenance` goes from `ProvenanceMeta | null` to `Record<string, unknown> | null`. Safe — `buildAdaptedDecision` assigns `JSON.parse(...)` (type `any`) into it and no consumer reads `provenance.source`/`.confidence` — and intentional (forward-compatible per the schema's "kept permissive" TSDoc). Keep a one-line note in the `AdaptedDecisionSchema` TSDoc so the looseness reads as deliberate, not accidental.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server/api-schemas.ts tests/api/api-schemas.test.ts src/mcp-server/api-decisions.ts src/mcp-server/api-edges.ts
git commit -m "feat(api): Zod contract schemas as single source of truth (v1)"
```

---

## Task 3: HTTP freshness adapter (`api-freshness.ts`)

Reuses `freshnessForContext` (no new freshness logic). Resolves the project's repo from the registry by name and opens its own short-lived readonly handle, so it needs no `GraphStore` internals. The ETag is the **index baseline** (changes only on reindex); the verdict is the **live staleness signal** — the two-signal model from spec §1.

**Files:**
- Create: `src/mcp-server/api-freshness.ts`
- Test: `tests/api/api-freshness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/api-freshness.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeEtag } from "../../src/mcp-server/api-freshness.js";
import type { IndexMeta } from "../../src/graph/index-meta.js";

describe("computeEtag", () => {
  const meta: IndexMeta = { indexed_commit: "abc", indexed_dirty_sig: "sig", indexed_at: "2026-01-01" };

  it("is a quoted strong validator carrying version + project", () => {
    const tag = computeEtag("cortex", meta);
    expect(tag.startsWith('"1:cortex:')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
  });

  it("is stable for identical inputs and changes when the baseline changes", () => {
    expect(computeEtag("cortex", meta)).toBe(computeEtag("cortex", meta));
    const moved = { ...meta, indexed_commit: "def" };
    expect(computeEtag("cortex", moved)).not.toBe(computeEtag("cortex", meta));
  });

  it("differs by project and tolerates null meta / null project", () => {
    expect(computeEtag("a", meta)).not.toBe(computeEtag("b", meta));
    expect(computeEtag(null, null)).toMatch(/^"1:_:/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/api/api-freshness.test.ts`
Expected: FAIL — cannot find `api-freshness.js`.

- [ ] **Step 3: Write `api-freshness.ts`**

Create `src/mcp-server/api-freshness.ts`:
```ts
/**
 * HTTP freshness adapter — the two-signal model (spec §1).
 *
 * `computeEtag` derives a strong cache validator from the index BASELINE
 * (indexed_commit/dirty_sig/indexed_at) — it changes only when the graph DB is
 * republished (reindex), so it is the right `If-None-Match` target for the
 * per-project data endpoints.
 *
 * `httpFreshnessFor` returns the live staleness VERDICT (whether the index is
 * behind the working tree) by reusing `freshnessForContext`. It resolves any
 * project's repo path from the registry by name and opens its own short-lived
 * readonly handle, so it needs no GraphStore internals. `canonical` mirrors the
 * `cortex freshness` CLI: dbPath === the repo's .cortex/db.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { freshnessForContext, type Freshness } from "./freshness.js";
import { readIndexMeta, type IndexMeta } from "../graph/index-meta.js";
import { resolveGraphDbForRead, resolveCortexDbPath } from "../db/resolve-path.js";

const ETAG_VERSION = 1;

/** Strong validator: `"<version>:<project>:<sha256(baseline)[:32]>"`. */
export function computeEtag(project: string | null, meta: IndexMeta | null): string {
  const proj = project ?? "_";
  const basis = `${ETAG_VERSION}:${proj}:${meta?.indexed_commit ?? ""}|${meta?.indexed_dirty_sig ?? ""}|${meta?.indexed_at ?? ""}`;
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 32);
  return `"${ETAG_VERSION}:${proj}:${hash}"`;
}

export interface HttpFreshness {
  verdict: Freshness;
  etag: string;
}

/** Compute the verdict + ETag for a resolved project name (null/unknown →
 *  `unknown` verdict + baseline-less ETag). `registry` is the open master
 *  Registry the server already holds. */
export function httpFreshnessFor(
  project: string | null,
  registry: { findByName(name: string): { root_path: string } | null },
): HttpFreshness {
  const rootPath = project ? registry.findByName(project)?.root_path ?? null : null;
  if (!rootPath) {
    return {
      verdict: { state: "unknown", note: "project not in registry — freshness unavailable" },
      etag: computeEtag(project, null),
    };
  }
  const dbPath = resolveGraphDbForRead(rootPath) ?? resolveCortexDbPath(rootPath);
  let handle: Database.Database | null = null;
  let meta: IndexMeta | null = null;
  let verdict: Freshness;
  try {
    handle = new Database(dbPath, { readonly: true, fileMustExist: true });
    meta = readIndexMeta(handle);
    const canonical = dbPath === resolveCortexDbPath(rootPath);
    verdict = freshnessForContext({ repoPath: rootPath, graphDb: handle, canonical });
  } catch {
    verdict = { state: "empty", note: "graph DB unavailable" };
  } finally {
    handle?.close();
  }
  return { verdict, etag: computeEtag(project, meta) };
}
```

> Verified against the source: `resolveGraphDbForRead` (returns `string | null`) and
> `resolveCortexDbPath` (returns `string`) are both exported from `src/db/resolve-path.ts`,
> so the `resolveGraphDbForRead(rootPath) ?? resolveCortexDbPath(rootPath)` fallback typechecks.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/api-freshness.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/api-freshness.ts tests/api/api-freshness.test.ts
git commit -m "feat(api): HTTP freshness adapter — ETag baseline validator + verdict"
```

---

## Task 4: The `respond()` chokepoint (`api-respond.ts`)

Every JSON response flows through here: validate (throw-in-test / log-in-prod), `304` on `If-None-Match`, stamp `version` + `X-Cortex-API-Version` + `X-Cortex-Freshness` + `ETag`, serialize.

**Files:**
- Create: `src/mcp-server/api-respond.ts`
- Test: `tests/api/api-respond.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/api-respond.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { respond, type RespondCtx } from "../../src/mcp-server/api-respond.js";

// Minimal ServerResponse fake.
function fakeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    writeHead(code: number, h?: Record<string, string>) { this.statusCode = code; Object.assign(this.headers, h ?? {}); return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
    end(chunk?: string) { if (chunk) this.body += chunk; this.ended = true; },
  };
}
const Schema = z.object({ version: z.literal(1), ok: z.literal(true) });
const baseCtx = (over: Partial<RespondCtx> = {}): RespondCtx => ({
  req: { headers: {} } as any,
  freshness: { state: "fresh" },
  etag: '"1:cortex:abc"',
  ...over,
});

describe("respond", () => {
  it("writes 200 with body + version/etag/freshness headers", () => {
    const res = fakeRes();
    respond(res as any, Schema, { version: 1, ok: true }, baseCtx());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ version: 1, ok: true });
    expect(res.headers["X-Cortex-API-Version"]).toBe("1");
    expect(res.headers["X-Cortex-Freshness"]).toBe("fresh");
    expect(res.headers["ETag"]).toBe('"1:cortex:abc"');
    expect(res.headers["Content-Type"]).toBe("application/json");
  });

  it("emits 304 with no body when If-None-Match matches the ETag", () => {
    const res = fakeRes();
    const ctx = baseCtx({ req: { headers: { "if-none-match": '"1:cortex:abc"' } } as any });
    respond(res as any, Schema, { version: 1, ok: true }, ctx);
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe("");
    expect(res.headers["ETag"]).toBe('"1:cortex:abc"');
  });

  it("throws on a schema mismatch under test (strict)", () => {
    const res = fakeRes();
    expect(() => respond(res as any, Schema, { version: 2, ok: true } as any, baseCtx())).toThrow();
  });

  it("logs + sends on mismatch when not strict", () => {
    const res = fakeRes();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    respond(res as any, Schema, { version: 2, ok: true } as any, baseCtx({ strict: false }));
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/api/api-respond.test.ts`
Expected: FAIL — cannot find `api-respond.js`.

- [ ] **Step 3: Write `api-respond.ts`**

Create `src/mcp-server/api-respond.ts`:
```ts
/**
 * The single JSON-response chokepoint for the HTTP contract.
 *
 * Responsibilities (so no handler can forget them):
 *  - validate the outgoing payload against its Zod schema, per the spec §3
 *    posture: THROW in test/CI (or under CORTEX_API_STRICT=1), else log + send;
 *  - honor `If-None-Match` → 304 Not Modified (empty body);
 *  - stamp `X-Cortex-API-Version`, `X-Cortex-Freshness`, and `ETag`;
 *  - serialize and end the response.
 *
 * `respondError` is the small sibling for 4xx/5xx (no schema validation).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ZodTypeAny } from "zod";
import type { Freshness } from "./freshness.js";
import { CONTRACT_VERSION } from "./api-schemas.js";

/** True when a response-schema mismatch must throw rather than log+send. */
export function isStrict(): boolean {
  return (
    process.env.CORTEX_API_STRICT === "1" ||
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test"
  );
}

export interface RespondCtx {
  req: IncomingMessage;
  freshness: Freshness;
  etag: string;
  /** Override the strict decision (tests). Defaults to `isStrict()`. */
  strict?: boolean;
  /** Extra headers (e.g. CORS) to merge in. */
  headers?: Record<string, string>;
}

export function respond<T>(
  res: ServerResponse,
  schema: ZodTypeAny,
  data: T,
  ctx: RespondCtx,
): void {
  const strict = ctx.strict ?? isStrict();
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    if (strict) {
      throw new Error(`API response schema mismatch: ${parsed.error.message}`);
    }
    console.error(`[cortex api] response schema mismatch (sent anyway): ${parsed.error.message}`);
  }

  const baseHeaders: Record<string, string> = {
    "X-Cortex-API-Version": String(CONTRACT_VERSION),
    "X-Cortex-Freshness": ctx.freshness.state,
    ETag: ctx.etag,
    "X-Content-Type-Options": "nosniff",
    ...(ctx.headers ?? {}),
  };

  const inm = ctx.req.headers["if-none-match"];
  if (typeof inm === "string" && inm === ctx.etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }

  // HEAD: stamp every header (incl. ETag) but send NO body, per HTTP semantics.
  res.writeHead(200, { ...baseHeaders, "Content-Type": "application/json" });
  res.end(ctx.req.method === "HEAD" ? undefined : JSON.stringify(data));
}

/** Error responses (no contract validation). */
export function respondError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify({ error: message }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/api-respond.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/api-respond.ts tests/api/api-respond.test.ts
git commit -m "feat(api): respond() chokepoint — validate, 304, stamp version/freshness/etag"
```

---

## Task 5: Hardening middleware (`api-middleware.ts`)

Small composable guards. All defaults inert for local single-user use.

**Files:**
- Create: `src/mcp-server/api-middleware.ts`
- Test: `tests/api/api-middleware.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/api-middleware.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  resolveBindHost, methodAllowed, corsHeadersFor, checkAuth, safeStaticPath, AUTH_EXEMPT, urlTooLong,
} from "../../src/mcp-server/api-middleware.js";
import { join, resolve } from "node:path";

describe("resolveBindHost", () => {
  it("defaults to loopback, honors override", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(resolveBindHost({ CORTEX_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

describe("methodAllowed", () => {
  it("allows GET/HEAD, rejects others", () => {
    expect(methodAllowed("GET")).toBe(true);
    expect(methodAllowed("HEAD")).toBe(true);
    expect(methodAllowed("POST")).toBe(false);
    expect(methodAllowed(undefined)).toBe(false);
  });
});

describe("corsHeadersFor", () => {
  it("emits nothing without an allowlist", () => {
    expect(corsHeadersFor("https://x.dev", {})).toEqual({});
  });
  it("reflects an allowlisted origin only", () => {
    const env = { CORTEX_CORS_ORIGINS: "https://a.dev,https://b.dev" };
    expect(corsHeadersFor("https://a.dev", env)["Access-Control-Allow-Origin"]).toBe("https://a.dev");
    expect(corsHeadersFor("https://evil.dev", env)).toEqual({});
    expect(corsHeadersFor(undefined, env)).toEqual({});
  });
});

describe("checkAuth", () => {
  it("passes when no token configured", () => {
    expect(checkAuth("/api/graph", undefined, {})).toBe(true);
  });
  it("requires a matching bearer when token set", () => {
    const env = { CORTEX_API_TOKEN: "s3cret" };
    expect(checkAuth("/api/graph", "Bearer s3cret", env)).toBe(true);
    expect(checkAuth("/api/graph", "Bearer wrong", env)).toBe(false);
    expect(checkAuth("/api/graph", undefined, env)).toBe(false);
  });
  it("exempts /api/health even when token set", () => {
    expect(checkAuth("/api/health", undefined, { CORTEX_API_TOKEN: "s3cret" })).toBe(true);
    expect(AUTH_EXEMPT.has("/api/health")).toBe(true);
  });
});

describe("safeStaticPath", () => {
  const dir = resolve("/srv/viewer");
  it("resolves a normal file under the dir", () => {
    expect(safeStaticPath(dir, "viewer.js")).toBe(join(dir, "viewer.js"));
  });
  it("rejects traversal escapes", () => {
    expect(safeStaticPath(dir, "../../etc/passwd")).toBeNull();
    expect(safeStaticPath(dir, "../secret")).toBeNull();
  });
});

describe("urlTooLong", () => {
  it("flags only over-limit request targets", () => {
    expect(urlTooLong("/api/graph")).toBe(false);
    expect(urlTooLong("/api/graph?project=" + "a".repeat(3000))).toBe(true);
    expect(urlTooLong(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/api/api-middleware.test.ts`
Expected: FAIL — cannot find `api-middleware.js`.

- [ ] **Step 3: Write `api-middleware.ts`**

Create `src/mcp-server/api-middleware.ts`:
```ts
/**
 * Hardening middleware for the viewer HTTP server (spec §4). Each guard is a
 * small pure function; the server composes them (method → CORS → auth) before
 * dispatch. Config is via env vars (matches how Mesh spawns the sidecar). All
 * defaults are inert for the local single-user case.
 */
import { timingSafeEqual } from "node:crypto";
import { resolve, join, sep } from "node:path";

type Env = Record<string, string | undefined>;

/** Endpoints reachable without a bearer token even when auth is enabled.
 *  ONLY non-sensitive liveness — never `/api/projects` (it leaks root_path). */
export const AUTH_EXEMPT = new Set<string>(["/api/health"]);

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

/** Bind interface. Loopback by default; `0.0.0.0` to deliberately expose. */
export function resolveBindHost(env: Env = process.env): string {
  return env.CORTEX_BIND_HOST?.trim() || "127.0.0.1";
}

export function methodAllowed(method: string | undefined): boolean {
  return method !== undefined && ALLOWED_METHODS.has(method);
}

/** Reject an over-long request target — cheap oversized-URL / request-line guard
 *  (spec §4 row 7). */
export const MAX_URL_LENGTH = 2048;
export function urlTooLong(url: string | undefined): boolean {
  return (url?.length ?? 0) > MAX_URL_LENGTH;
}

/** CORS headers for a request Origin. Empty unless the origin is allowlisted via
 *  CORTEX_CORS_ORIGINS (comma-separated). Mesh fetches from Node (no CORS), so
 *  the default empty allowlist costs it nothing. */
export function corsHeadersFor(origin: string | undefined, env: Env = process.env): Record<string, string> {
  if (!origin) return {};
  const allow = (env.CORTEX_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, If-None-Match",
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True if the request is authorized. No token configured → always true. The
 *  liveness path in AUTH_EXEMPT is always allowed. `pathname` must be the URL
 *  path WITHOUT query string. */
export function checkAuth(pathname: string, authHeader: string | undefined, env: Env = process.env): boolean {
  const token = env.CORTEX_API_TOKEN?.trim();
  if (!token) return true;
  if (AUTH_EXEMPT.has(pathname)) return true;
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  return safeEqual(authHeader.slice(prefix.length), token);
}

/** Resolve a static-file request safely. Returns the absolute path only if it
 *  stays within `viewerDir`; null on any traversal escape. */
export function safeStaticPath(viewerDir: string, rel: string): string | null {
  const base = resolve(viewerDir);
  const full = resolve(join(base, rel));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/** Baseline security headers for served documents/assets. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/api-middleware.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/api-middleware.ts tests/api/api-middleware.test.ts
git commit -m "feat(api): hardening middleware — bind/method/CORS/auth/traversal guards"
```

---

## Task 6: Refactor `api.ts` — route table, middleware, new endpoints, bind host

Wire everything into `startViewerServer`: a per-request middleware chain (method → CORS → auth), an ordered route table, every JSON response via `respond()`, the new `/api/health` + `/api/freshness` endpoints, traversal-safe static serving, and `listen(port, host)`.

**Files:**
- Modify: `src/mcp-server/api.ts`
- Test: `tests/api/api-server.test.ts` (new integration test)

> **Note:** the branch is already rebased onto merged main (0.8.23), so `api.ts`'s base
> has the `positionAggregates`-based `/api/aggregates` handler + the `frame-map.ts`
> changes. The aggregates handler below simply wraps that merged body in `respond()`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/api/api-server.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { GraphStore } from "../../src/graph/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated, empty store on a temp db so the server starts deterministically.
let handle: ViewerServerHandle;
let base: string;
let store: GraphStore;
let dir: string;

beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0"; // ephemeral port (see Step 3(d))
  dir = mkdtempSync(join(tmpdir(), "cortex-api-"));
  store = new GraphStore(join(dir, "db"));
  handle = await startViewerServer(store, null);
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(() => {
  handle?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("viewer HTTP contract", () => {
  it("GET /api/health is unauthenticated and versioned", async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Cortex-API-Version")).toBe("1");
    expect(await r.json()).toEqual({ version: 1, ok: true });
  });

  it("GET /api/graph carries version + ETag + freshness headers", async () => {
    const r = await fetch(`${base}/api/graph`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe(1);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(r.headers.get("ETag")).toBeTruthy();
    expect(r.headers.get("X-Cortex-Freshness")).toBeTruthy();
  });

  it("If-None-Match returns 304", async () => {
    const r1 = await fetch(`${base}/api/graph`);
    const etag = r1.headers.get("ETag")!;
    const r2 = await fetch(`${base}/api/graph`, { headers: { "If-None-Match": etag } });
    expect(r2.status).toBe(304);
  });

  it("GET /api/freshness returns a verdict", async () => {
    const r = await fetch(`${base}/api/freshness`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe(1);
    expect(typeof body.state).toBe("string");
  });

  it("rejects non-GET with 405", async () => {
    const r = await fetch(`${base}/api/graph`, { method: "POST" });
    expect(r.status).toBe(405);
  });

  it("rejects a path-traversal static request", async () => {
    const r = await fetch(`${base}/viewer/../../../../etc/passwd`);
    expect([400, 404]).toContain(r.status);
  });

  it("HEAD /api/graph returns headers + ETag with no body", async () => {
    const r = await fetch(`${base}/api/graph`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("ETag")).toBeTruthy();
    expect(await r.text()).toBe("");
  });

  it("rejects an oversized request target with 414", async () => {
    const r = await fetch(`${base}/api/graph?project=${"a".repeat(3000)}`);
    expect(r.status).toBe(414);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/api/api-server.test.ts`
Expected: FAIL — `/api/health` 404 / no version header (endpoints + middleware not wired yet). (If `CORTEX_VIEWER_PORT=0` isn't honored yet, the bind also fails — fixed in Step 3.)

- [ ] **Step 3: Refactor the `createServer` callback in `api.ts`**

In `src/mcp-server/api.ts`:

(a) **Add imports** at the top (after the existing imports):
```ts
import { respond, respondError } from "./api-respond.js";
import { httpFreshnessFor } from "./api-freshness.js";
import {
  resolveBindHost, methodAllowed, corsHeadersFor, checkAuth, safeStaticPath, SECURITY_HEADERS, urlTooLong,
} from "./api-middleware.js";
import {
  CONTRACT_VERSION, GraphResponseSchema, ProjectsResponseSchema, FramesResponseSchema,
  FileEdgesResponseSchema, AggregatesResponseSchema, DecisionsResponseSchema,
  DecisionDetailResponseSchema, FreshnessResponseSchema, HealthResponseSchema,
  ProjectParamSchema, DecisionIdParamSchema,
} from "./api-schemas.js";
```

(b) **Replace the body of the `createHttpServer(async (req, res) => { … })` callback.** Keep the `registry` setup above it and the bind logic below it. The new callback:

```ts
const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || "/";
  const parsed = new NodeURL(url, "http://localhost");
  const pathname = parsed.pathname;
  const origin = req.headers["origin"] as string | undefined;
  const cors = corsHeadersFor(origin, process.env);

  // Oversized request-target guard (cheap DoS/abuse limit, spec §4 row 7).
  if (urlTooLong(req.url)) { respondError(res, 414, "request-target too long", cors); return; }

  // CORS preflight (only answered for allowlisted origins; cors is {} otherwise).
  if (req.method === "OPTIONS") {
    if (Object.keys(cors).length > 0) { res.writeHead(204, cors); res.end(); }
    else respondError(res, 405, "method not allowed");
    return;
  }
  // Method gate.
  if (!methodAllowed(req.method)) { respondError(res, 405, "method not allowed", cors); return; }
  // Auth (API paths only; static viewer is public).
  if (pathname.startsWith("/api/") && !checkAuth(pathname, req.headers["authorization"], process.env)) {
    respondError(res, 401, "unauthorized", cors);
    return;
  }

  // Validate the shared `project` query param once (fail-closed 400).
  const projectParamRaw = parsed.searchParams.get("project") ?? undefined;
  const projectParam = ProjectParamSchema.safeParse(projectParamRaw);
  if (!projectParam.success) { respondError(res, 400, "invalid project parameter", cors); return; }
  const project = projectParam.data ?? indexerProject ?? undefined;
  const freshCtx = () => {
    const { verdict, etag } = httpFreshnessFor(project ?? null, registry);
    return { req, freshness: verdict, etag, headers: cors };
  };

  // ── /api/health (unauthenticated liveness) ──
  if (pathname === "/api/health") {
    respond(res, HealthResponseSchema, { version: CONTRACT_VERSION, ok: true as const }, { ...freshCtx() });
    return;
  }

  // ── /api/freshness ──
  if (pathname === "/api/freshness") {
    const { verdict, etag } = httpFreshnessFor(project ?? null, registry);
    respond(res, FreshnessResponseSchema, { version: CONTRACT_VERSION, ...verdict }, { req, freshness: verdict, etag, headers: cors });
    return;
  }

  // ── /api/graph ──
  if (pathname === "/api/graph") {
    const resolved = openProjectStore(store, indexerProject, project, { registry });
    if (!resolved) {
      respond(res, GraphResponseSchema, { version: CONTRACT_VERSION, nodes: [], edges: [], project: project ?? null }, freshCtx());
      return;
    }
    try {
      const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
      const rawEdges = resolved.store.getAllEdgesUnified(project ?? undefined);
      const edges = rawEdges.map((e) => ({ ...e, source: e.source_id, target: e.target_id }));
      respond(res, GraphResponseSchema, { version: CONTRACT_VERSION, nodes, edges, project: project ?? null }, freshCtx());
    } finally {
      if (resolved.owned) resolved.store.close();
    }
    return;
  }

  // ── /api/projects ──
  if (pathname === "/api/projects") {
    let projects: ReturnType<typeof listProjectsUnified> = [];
    try { projects = listProjectsUnified(store); } catch { /* no ctx_projects yet */ }
    respond(res, ProjectsResponseSchema, { version: CONTRACT_VERSION, projects, active: indexerProject ?? null }, freshCtx());
    return;
  }

  // ── /api/decisions/:id ── (must precede the list route)
  if (pathname.startsWith("/api/decisions/")) {
    if (!decisionsRepo || !decisionLinksRepo) { respondError(res, 503, "decisions repos unavailable", cors); return; }
    const idRaw = decodeURIComponent(pathname.slice("/api/decisions/".length));
    const idParsed = DecisionIdParamSchema.safeParse(idRaw);
    if (!idParsed.success) { respondError(res, 400, "invalid decision id", cors); return; }
    const pd = openProjectDecisions(decisionsRepo, decisionLinksRepo, indexerProject, project, registry);
    try {
      const rec = pd.decisions.get(idParsed.data);
      if (!rec) { respondError(res, 404, "decision not found", cors); return; }
      const links = pd.links.findByDecision(idParsed.data);
      const resolved = openProjectStore(store, indexerProject, project, { registry });
      const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
      try {
        const { nodesByPath, framesByPath } = buildPathIndices(nodes);
        const decision = buildAdaptedDecision(rec, links, nodesByPath, framesByPath);
        respond(res, DecisionDetailResponseSchema, { version: CONTRACT_VERSION, decision }, freshCtx());
      } finally {
        if (resolved?.owned) resolved.store.close();
      }
    } finally {
      pd.close();
    }
    return;
  }

  // ── /api/decisions ──
  if (pathname === "/api/decisions") {
    if (!decisionsRepo || !decisionLinksRepo) { respondError(res, 503, "decisions repos unavailable", cors); return; }
    const pd = openProjectDecisions(decisionsRepo, decisionLinksRepo, indexerProject, project, registry);
    const resolved = openProjectStore(store, indexerProject, project, { registry });
    const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
    try {
      const records = pd.decisions.list();
      const allLinks = records.flatMap((r) => pd.links.findByDecision(r.id));
      const { nodesByPath, framesByPath } = buildPathIndices(nodes);
      const decisions = buildAdaptedDecisions(records, allLinks, nodesByPath, framesByPath);
      respond(res, DecisionsResponseSchema, { version: CONTRACT_VERSION, decisions }, freshCtx());
    } finally {
      if (resolved?.owned) resolved.store.close();
      pd.close();
    }
    return;
  }

  // ── /api/aggregates ── (positionAggregates + buildFrameMap are ALREADY imported
  // at the top of api.ts post-rebase — wrap the merged 0.8.23 body in respond().
  // Do NOT switch to groupAuxiliaryPaths; that drops the x/y the viewer renders.)
  if (pathname === "/api/aggregates") {
    const resolved = openProjectStore(store, indexerProject, project, { registry });
    const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
    try {
      const edges = resolved ? resolved.store.getAllEdgesUnified(project ?? undefined) : [];
      const frameMap = buildFrameMap(nodes, edges);
      const aggregates = positionAggregates(nodes, edges, frameMap);
      respond(res, AggregatesResponseSchema, { version: CONTRACT_VERSION, aggregates }, freshCtx());
    } finally {
      if (resolved?.owned) resolved.store.close();
    }
    return;
  }

  // ── /api/frames ──
  if (pathname === "/api/frames") {
    const resolved = openProjectStore(store, indexerProject, project, { registry });
    if (!resolved) {
      respond(res, FramesResponseSchema, { version: CONTRACT_VERSION, frames: [], stage: { w: STAGE_W, h: STAGE_H } }, freshCtx());
      return;
    }
    try {
      const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
      const edges = resolved.store.getAllEdgesUnified(project ?? undefined);
      const map = buildFrameMap(nodes, edges);
      respond(res, FramesResponseSchema, { version: CONTRACT_VERSION, ...map }, freshCtx());
    } finally {
      if (resolved.owned) resolved.store.close();
    }
    return;
  }

  // ── /api/file-edges ──
  if (pathname === "/api/file-edges") {
    const resolved = openProjectStore(store, indexerProject, project, { registry });
    if (!resolved) {
      respond(res, FileEdgesResponseSchema, { version: CONTRACT_VERSION, file_edges: [] }, freshCtx());
      return;
    }
    try {
      const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
      const edges = resolved.store.getAllEdgesUnified(project ?? undefined);
      const file_edges = buildFileEdges(nodes, edges, { relations: ["CALLS", "USAGE", "IMPORTS"] });
      respond(res, FileEdgesResponseSchema, { version: CONTRACT_VERSION, file_edges }, freshCtx());
    } finally {
      if (resolved.owned) resolved.store.close();
    }
    return;
  }

  // ── static viewer (traversal-safe) ──
  if (pathname === "/" || pathname.startsWith("/viewer")) {
    const rel = (pathname === "/" || pathname === "/viewer" || pathname === "/viewer/")
      ? "index.html"
      : pathname.replace(/^\/viewer\//, "");
    const filePath = safeStaticPath(VIEWER_DIR, rel);
    if (!filePath) { respondError(res, 404, "not found", cors); return; }
    try {
      const content = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream", ...SECURITY_HEADERS, ...cors });
      res.end(content);
    } catch {
      respondError(res, 404, "not found", cors);
    }
    return;
  }

  res.writeHead(302, { Location: "/viewer", ...cors });
  res.end();
});
```

(c) **Bind to the resolved host.** In the `attempt()` closure further down, change:
```ts
httpServer.listen(port);
```
to:
```ts
httpServer.listen(port, resolveBindHost(process.env));
```

(d) **Report the OS-assigned port** (needed so `CORTEX_VIEWER_PORT=0` in the integration tests yields a real `handle.port`). The handle is resolved inside the `bindWithRetry(...).then((ok) => { if (ok) { resolve({ port, … }) } … })` success branch (near api.ts:438), where the captured `port` is the *requested* value (0 in tests). Replace it with the actual bound port — computed ONLY in the success branch (never the `attempt()` closure, which has no handle; never the failure branch, which keeps `port: -1`):
```ts
.then((ok) => {
  if (ok) {
    const addr = httpServer.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : port;
    resolve({
      port: actualPort,
      httpServer,
      close() { httpServer.close(); registry.close(); },
    });
  } else {
    resolve({ port: -1, httpServer: null, close() { registry.close(); } });
  }
});
```
`address()` is non-null here because the success branch runs only after the `listening` event. A non-zero `CORTEX_VIEWER_PORT` is unchanged (`actualPort` === requested).

(e) **Set request limits (spec §4 row 7).** Immediately after `const httpServer = createHttpServer(...)` (and before `bindWithRetry`), add finite timeouts so a slow-headers / Slowloris client can't pin a socket:
```ts
httpServer.requestTimeout = 30_000;   // ms — whole-request ceiling
httpServer.headersTimeout = 35_000;   // ms — must exceed requestTimeout
```
The oversized-URL guard (`urlTooLong` → `414`) is already wired at the top of the request callback in (b). Together with the GET/HEAD method gate (which rejects request bodies before they're read), these complete the §4 "Limits" row.

Run: `npx vitest run tests/api/api-server.test.ts`
Expected: PASS (health, graph headers, 304, freshness, 405, traversal-404).

- [ ] **Step 5: Run the FULL existing API suite to confirm no regression**

Run: `npx vitest run tests/api/`
Expected: PASS — the existing `tests/api/edges-adapter`, `decisions-adapter`, `decisions-routing` (all pure unit tests of the adapters / `openProjectDecisions`; none make an HTTP call or assert a wire body, so none need editing) plus the new ones. The only `/api/decisions/:id` wire-body coverage is the new `api-server.test.ts`; to cover `:id`, add an assertion there (the temp-db store has no decisions, so assert the `404` path, or seed one first).

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: exit 0; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server/api.ts tests/api/api-server.test.ts
git commit -m "feat(api): route table + middleware + /api/health + /api/freshness + bind host"
```

---

## Task 7: Schema doc generator + drift guard

**Files:**
- Create: `scripts/gen-api-schemas.ts`
- Create: `docs/api/*.schema.json` (generated output, committed)
- Test: `tests/api/schema-drift.test.ts`

- [ ] **Step 1: Write `gen-api-schemas.ts`**

Create `scripts/gen-api-schemas.ts`:
```ts
/**
 * Generate docs/api/<name>.schema.json from the Zod RESPONSE_SCHEMAS
 * (src/mcp-server/api-schemas.ts). Run `npm run gen:api-schemas` after changing
 * a schema; the drift-guard test fails CI if the committed JSON is out of date.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RESPONSE_SCHEMAS } from "../src/mcp-server/api-schemas.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "api");

/** Deterministic JSON Schema text for one named schema (stable across runs). */
export function schemaJson(name: string, schema: Parameters<typeof zodToJsonSchema>[0]): string {
  const json = zodToJsonSchema(schema, { name, target: "jsonSchema7" });
  return JSON.stringify(json, null, 2) + "\n";
}

export function generateAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(RESPONSE_SCHEMAS)) {
    out[name] = schemaJson(name, schema);
  }
  return out;
}

// Only write to disk when executed directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, text] of Object.entries(generateAll())) {
    writeFileSync(join(OUT_DIR, `${name}.schema.json`), text);
  }
  console.error(`Wrote ${Object.keys(RESPONSE_SCHEMAS).length} schema files to docs/api/`);
}
```

- [ ] **Step 2: Generate the committed schema files**

Run: `npm run gen:api-schemas`
Expected: `docs/api/graph.schema.json`, `projects.schema.json`, `frames.schema.json`, `file-edges.schema.json`, `aggregates.schema.json`, `decisions.schema.json`, `decision-detail.schema.json`, `freshness.schema.json`, `health.schema.json` created.

- [ ] **Step 3: Write the drift-guard test**

Create `tests/api/schema-drift.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAll } from "../../scripts/gen-api-schemas.js";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "api");

describe("api schema docs are not stale", () => {
  const generated = generateAll();
  for (const [name, text] of Object.entries(generated)) {
    it(`docs/api/${name}.schema.json matches the Zod source`, () => {
      const committed = readFileSync(join(DOCS, `${name}.schema.json`), "utf8");
      expect(committed).toBe(text); // run `npm run gen:api-schemas` if this fails
    });
  }
});
```

- [ ] **Step 4: Run the drift guard**

Run: `npx vitest run tests/api/schema-drift.test.ts`
Expected: PASS (committed == generated).

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-api-schemas.ts docs/api/*.schema.json tests/api/schema-drift.test.ts
git commit -m "feat(api): generate docs/api JSON schemas from Zod + drift guard test"
```

---

## Task 8: Hardening + conformance integration tests

Prove the live wire matches the schemas and the guards actually guard.

**Files:**
- Create: `tests/api/api-conformance.test.ts`
- Create: `tests/api/api-hardening.test.ts`

- [ ] **Step 1: Write the conformance test**

Create `tests/api/api-conformance.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { GraphStore } from "../../src/graph/store.js";
import {
  GraphResponseSchema, ProjectsResponseSchema, FramesResponseSchema,
  FileEdgesResponseSchema, AggregatesResponseSchema, FreshnessResponseSchema, HealthResponseSchema,
} from "../../src/mcp-server/api-schemas.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let handle: ViewerServerHandle, base: string;
beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), "cortex-conf-")), "db"));
  handle = await startViewerServer(store, null);
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(() => handle?.close());

const CASES: [string, { safeParse: (d: unknown) => { success: boolean } }][] = [
  ["/api/health", HealthResponseSchema],
  ["/api/freshness", FreshnessResponseSchema],
  ["/api/projects", ProjectsResponseSchema],
  ["/api/graph", GraphResponseSchema],
  ["/api/frames", FramesResponseSchema],
  ["/api/file-edges", FileEdgesResponseSchema],
  ["/api/aggregates", AggregatesResponseSchema],
];

describe("live responses conform to their schema", () => {
  for (const [path, schema] of CASES) {
    it(`${path} conforms`, async () => {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(200);
      expect(schema.safeParse(await r.json()).success).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Write the hardening test (auth + CORS + inputs)**

Create `tests/api/api-hardening.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startViewerServer, type ViewerServerHandle } from "../../src/mcp-server/api.js";
import { GraphStore } from "../../src/graph/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let handle: ViewerServerHandle, base: string;
beforeAll(async () => {
  process.env.CORTEX_VIEWER_PORT = "0";
  process.env.CORTEX_API_TOKEN = "test-token";
  process.env.CORTEX_CORS_ORIGINS = "https://mesh.dev";
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), "cortex-hard-")), "db"));
  handle = await startViewerServer(store, null);
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(() => {
  delete process.env.CORTEX_API_TOKEN;
  delete process.env.CORTEX_CORS_ORIGINS;
  handle?.close();
});

describe("auth", () => {
  it("401 without a token", async () => {
    expect((await fetch(`${base}/api/graph`)).status).toBe(401);
  });
  it("200 with the bearer token", async () => {
    const r = await fetch(`${base}/api/graph`, { headers: { Authorization: "Bearer test-token" } });
    expect(r.status).toBe(200);
  });
  it("/api/health is exempt", async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
  it("/api/projects is NOT exempt (root_path is sensitive)", async () => {
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  });
});

describe("CORS allowlist", () => {
  it("reflects an allowlisted origin", async () => {
    const r = await fetch(`${base}/api/health`, { headers: { Origin: "https://mesh.dev" } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://mesh.dev");
  });
  it("ignores a non-allowlisted origin", async () => {
    const r = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.dev" } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("input validation", () => {
  it("400 on empty project param", async () => {
    const r = await fetch(`${base}/api/graph?project=`, { headers: { Authorization: "Bearer test-token" } });
    expect(r.status).toBe(400);
  });
});
```

> In both this and `api-conformance.test.ts`, mirror `api-server.test.ts`'s temp
> cleanup: hoist `store`/`dir` to module scope and in `afterAll` add `store.close()`
> + `rmSync(dir, { recursive: true, force: true })` after `handle?.close()` — avoids
> leaking sqlite handles + temp dirs when the full suite runs in one pool.

- [ ] **Step 3: Run both new tests**

Run: `npx vitest run tests/api/api-conformance.test.ts tests/api/api-hardening.test.ts`
Expected: PASS.

- [ ] **Step 4: Full suite**

Run: `npx vitest run`
Expected: green (now ≈1131 + the new files).

- [ ] **Step 5: Commit**

```bash
git add tests/api/api-conformance.test.ts tests/api/api-hardening.test.ts
git commit -m "test(api): live conformance + auth/CORS/input-validation hardening tests"
```

---

## Task 9: Documentation (first-class — definition of done)

**Files:**
- Create: `docs/architecture/http-api-contract.md`
- Create: `docs/api/README.md`
- Modify: `docs/architecture/graph-ui.md`, `CLAUDE.md`, `README.md`, `TEST.md`

- [ ] **Step 1: Write `docs/architecture/http-api-contract.md`**

Create the onboarding doc with these sections (write real prose; no placeholders):
1. **Overview** — the seven endpoints + `/api/health`/`/api/freshness`; what Mesh consumes.
2. **Single source of truth** — Zod in `api-schemas.ts` → `z.infer` types → generated `docs/api/*.schema.json`. Never hand-edit the JSON.
3. **Validation postures** — request inputs fail-closed `400`; response outputs throw in test/CI, log+send in prod; `CORTEX_API_STRICT=1`.
4. **The `respond()` chokepoint** — version/freshness/ETag stamping + `304`.
5. **Freshness two-signal model** — ETag (index baseline → cache identity) vs verdict (live staleness); `/api/freshness` + `X-Cortex-Freshness`.
6. **Hardening middleware** — bind/method/CORS/auth/traversal/security-headers; the env table; ordering.
7. **Mesh consumer contract** — Node fetch (no CORS), sidecar spawn env, the cross-repo follow-ups.
8. **Maintenance workflow — "How to add or change an endpoint without breaking the contract":**
   ```
   1. Add/edit the Zod schema in src/mcp-server/api-schemas.ts (+ RESPONSE_SCHEMAS).
   2. Wire the handler in api.ts through respond(<Schema>, …).
   3. Run `npm run gen:api-schemas` to regenerate docs/api/*.schema.json.
   4. Run `npx vitest run tests/api/` — drift guard + conformance must pass.
   5. Breaking change (remove/rename/retype a field)? Bump CONTRACT_VERSION → 2.
   ```
   Include a **worked example** ("add `GET /api/stats` returning `{ version, node_count }`") walking all five steps with code.

- [ ] **Step 2: Write `docs/api/README.md`**

Consumer-facing reference: a table of endpoints (path, auth, body fields, conditional), the headers (`X-Cortex-API-Version`, `X-Cortex-Freshness`, `ETag`, `304`), the env-var table (from spec §6), and a one-paragraph "how to revalidate with `If-None-Match`" for clients. Link to the generated `*.schema.json` files. **Document `/api/freshness`'s optional `note?` field** (emitted on `unknown`/`empty` verdicts) — the Zod schema includes it, so the prose reference must too, keeping it in agreement with the generated `freshness.schema.json`.

- [ ] **Step 3: Update `docs/architecture/graph-ui.md`**

In the section that lists the `/api/*` endpoints, add a short subsection "**HTTP API contract (v1)**" linking to `http-api-contract.md` and noting the schema-governed, hardened layer.

- [ ] **Step 4: Update `CLAUDE.md`**

Under the **Viewer** section, append:
> The viewer's HTTP endpoints are a **versioned, Zod-enforced contract** (`src/mcp-server/api-schemas.ts` is the single source of truth). To change an endpoint, edit the Zod schema and run `npm run gen:api-schemas` — **never hand-edit `docs/api/*.schema.json`** (a drift-guard test enforces this). See [docs/architecture/http-api-contract.md](docs/architecture/http-api-contract.md). Hardening is env-gated: `CORTEX_BIND_HOST`, `CORTEX_API_TOKEN`, `CORTEX_CORS_ORIGINS`, `CORTEX_API_STRICT`.

- [ ] **Step 5: Update `README.md` + `TEST.md` env tables**

Add rows to the existing env-var tables: `CORTEX_BIND_HOST` (`127.0.0.1`), `CORTEX_API_TOKEN` (unset → no auth), `CORTEX_CORS_ORIGINS` (unset), `CORTEX_API_STRICT` (`1` → fail-closed responses).

- [ ] **Step 6: Verify / refresh TSDoc**

Confirm `api-schemas.ts`, `api-respond.ts`, `api-middleware.ts`, `api-freshness.ts` each carry the module-level TSDoc written in Tasks 2–5, and that exported functions have a one-line doc. **Also refresh the TSDoc on the refactored `startViewerServer` in `api.ts`** to describe its new orchestrator role (registry → route table → middleware chain → `respond`), per spec §11. Add any missing.

- [ ] **Step 7: Commit (docs-only)**

```bash
git add docs/ CLAUDE.md README.md TEST.md
git commit -m "docs(api): contract onboarding doc + consumer reference + env-var docs"
```

---

## Task 10: Decision capture (release-time)

**Files:** none (Cortex decision store).

- [ ] **Step 1: Check for a duplicate decision**

```
search_decisions({ repo_path: "<worktree abs path>", query: "HTTP API contract Zod versioned freshness hardening" })
```

- [ ] **Step 2: Create the decision**

```
create_decision({
  repo_path: "<worktree abs path>",
  title: "Versioned, Zod-enforced HTTP contract with freshness + hardened opt-in-exposable surface",
  description: "Seven viewer endpoints become a versioned contract; one Zod schema per response is the single source of truth (runtime validation + z.infer types + generated docs/api JSON Schema with a drift guard). Freshness exposed via X-Cortex-Freshness + /api/freshness + ETag/304. Hardening: loopback bind, traversal guard, CORS allowlist, method gate, opt-in bearer auth, security headers.",
  rationale: "Single source of truth beats docs-only schemas (which drift). Consumer-driven by Mesh (Node fetch, sidecar spawn env, blind-TTL cache). Defense-in-depth so the surface is safe to deliberately expose later.",
  alternatives: ["docs-only JSON Schema (rejected — drifts)", "framework router (rejected — overkill for 7 endpoints)", "fail-closed response validation (rejected — runtime fragility)"],
  governs: ["src/mcp-server/api-schemas.ts", "src/mcp-server/api.ts::startViewerServer", "docs/api/"]
})
```

- [ ] **Step 3: Link governance** (if `create_decision` didn't capture `governs` as links)

```
link_decision({ repo_path: "<worktree abs path>", decision_id: "<id>", target: "src/mcp-server/api-schemas.ts", relation: "GOVERNS" })
```

---

## Task 11: Release (0.9.0)

**Files:** `package.json`, `plugin.json`, `.claude-plugin/marketplace.json`, `CHANGELOG.md`, `HANDOFF.md`.

- [ ] **Step 1: Re-sync with main (safety re-check — floating-entity 0.8.23 already merged + rebased)**

```bash
git fetch origin && git rebase origin/main   # branch is already on 0.8.23; a no-op unless main moved again
npx vitest run tests/api/
```

- [ ] **Step 2: Bump all three version fields to `0.9.0`** (per workflow.md; minor, confirmed).

- [ ] **Step 3: Add the `CHANGELOG.md` entry** under `## [0.9.0]` with `Added` (versioned contract, `/api/health`, `/api/freshness`, ETag/304, hardening env vars, generated schemas) / `Changed` (responses carry `version`; loopback-default bind) sections + the link reference.

- [ ] **Step 4: Mark P6 shipped in `HANDOFF.md`.**

- [ ] **Step 5: Gate 2 QA, then PR + CI gate, then merge** (workflow.md release protocol).

```bash
git commit -am "chore(release): 0.9.0 — versioned Zod HTTP contract + freshness + hardening"
git push -u origin feature/api/versioned-contract-hardening
gh pr create --base main --title "Versioned Zod HTTP contract + freshness + hardening (P6)" --body "<what + why; links spec + plan>"
# wait for CI gate to pass, then:
gh pr merge feature/api/versioned-contract-hardening --merge
git worktree remove ../cortex-wt-api-contract && git worktree prune
```

---

## Self-review notes

- **Spec coverage:** §1 freshness → Tasks 3,6,8; §2 versioning → Task 2 (`z.literal`) + handlers in 6; §3 schemas+posture → Tasks 2,4; §4 hardening — **all 7 guards** incl. **Limits (`urlTooLong`→414 + request/headers timeouts, Tasks 5/6/8)** → Tasks 5,6,8; §5 docs-gen+drift → Task 7; §6 refactor → Task 6; §11 docs → Task 9; §12 decision → Task 10; §13 release → Task 11. All covered.
- **§5 cross-repo conformance is intentionally out of scope for this branch** — it is the Mesh-side follow-up (spec §10 item 4: vendor `docs/api/*.schema.json` into `fake-cortex.mjs` / e2e fixtures). This branch produces + guards the Cortex-side artifact only.
- **No `src/index.ts` change needed** (despite spec §7 listing it): the new env vars are read directly via `process.env` inside `api-middleware.ts` (`resolveBindHost`, `checkAuth`, `corsHeadersFor`) and `api-respond.ts` (`isStrict`), and the bind host at the `listen()` call in `api.ts`. No curated env passthrough is required.
- **HEAD semantics:** `respond()` stamps headers (incl. ETag) but sends no body for `HEAD` (Task 4); covered by an `api-server.test.ts` assertion (Task 6).
- **Adversarial verification (4-critic workflow, 2026-06-16):** applied — aggregates handler/schema corrected to the merged `positionAggregates`+`x`/`y` shape; §4 Limits gap closed; ephemeral-port edit made explicit; HEAD body fixed; decisions-routing false premise removed; `zod-to-json-schema` API confirmed via context7.
- **Gate 0 (visual QA):** Task 6 changes the viewer server — before merge, run `npm run dev`, load `/viewer`, confirm it renders + switches projects with no console errors and the new headers are present (per workflow.md). Add a screenshot to `.playwright-mcp/`.
- **Type consistency:** `CONTRACT_VERSION`, `RESPONSE_SCHEMAS`, `httpFreshnessFor`, `computeEtag`, `respond`/`respondError`, `resolveBindHost`/`methodAllowed`/`corsHeadersFor`/`checkAuth`/`safeStaticPath`/`urlTooLong`/`AUTH_EXEMPT`/`SECURITY_HEADERS` are used consistently across tasks.
