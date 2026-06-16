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
/** Mirrors a row from `getAllNodesUnified` (`SELECT * FROM nodes`). The TS
 *  `NodeRow` interface declares only the first 9 columns, but the wire ships the
 *  full row — `start_line`/`end_line`/`project` are real columns that reach Mesh +
 *  the viewer, so they're ratified here ("freeze, don't reshape"). Non-strict by
 *  design: a future additive column stays within contract v1 (no break, no prod 500). */
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
  start_line: z.number().nullable(),
  end_line: z.number().nullable(),
  project: z.string().nullable(),
});
/** Mirrors a row from `getAllEdgesUnified` (`SELECT * FROM edges`) + the viewer
 *  `source`/`target` aliases the handler adds. `project` is a real column on the
 *  wire (the TS `EdgeRow` interface omits it). Non-strict by design. */
export const EdgeSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  target_id: z.string(),
  relation: z.string(),
  data: z.string(),
  created_at: z.string(),
  project: z.string().nullable(),
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
export type FileEdge = z.infer<typeof FileEdgeSchema>;

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
 *  DELIBERATELY widened from ProvenanceMeta to a permissive record — forward-
 *  compatible, and safe because buildAdaptedDecision assigns JSON.parse(...) and
 *  no consumer reads its inner fields. */
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
