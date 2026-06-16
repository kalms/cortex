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
