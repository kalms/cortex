// tests/api/decisions-adapter.test.ts
import { describe, it, expect } from "vitest";
import {
  buildAdaptedDecisions,
  buildAdaptedDecision,
} from "../../src/mcp-server/api-decisions.js";
import type { DecisionRecord } from "../../src/decisions/repository.js";
import type { DecisionLink } from "../../src/decisions/links-repository.js";
import type { NodeRow } from "../../src/graph/store.js";

const baseDecision: DecisionRecord = {
  id: "dec-1",
  title: "Use SQLite for the graph store",
  description: null,
  rationale: "Cross-platform, file-based, fast for read-heavy workloads.",
  problem: "Need a persistent graph store accessible from multiple agents.",
  resolution: "SQLite via better-sqlite3, attached read-only from CBM.",
  alternatives: JSON.stringify([
    { name: "Neo4j", reason_rejected: "Operationally heavy" },
    { name: "Postgres", reason_rejected: "Server process required" },
  ]),
  tier: "team",
  status: "active",
  superseded_by: null,
  author: "rasmus",
  created_at: "2026-03-05T10:00:00Z",
  updated_at: "2026-03-05T10:00:00Z",
};

const fileNode = (path: string, frameId?: number, frameLabel?: string): NodeRow => ({
  id: `n:${path}`,
  kind: "file",
  name: path.split("/").pop()!,
  qualified_name: null,
  file_path: path,
  project: "test",
  tier: null,
  status: null,
  data: JSON.stringify({
    ...(frameId !== undefined ? { frame_id: frameId, frame_label: frameLabel } : {}),
  }),
  created_at: "",
  updated_at: "",
} as unknown as NodeRow);

describe("buildAdaptedDecision", () => {
  it("maps repository fields to prototype shape", () => {
    const result = buildAdaptedDecision(baseDecision, [], new Map(), new Map());
    expect(result.id).toBe("dec-1");
    expect(result.summary).toBe("Use SQLite for the graph store");
    expect(result.state).toBe("active");
    expect(result.problem).toContain("persistent graph store");
    expect(result.resolution).toContain("SQLite via better-sqlite3");
    expect(result.rationale).toContain("Cross-platform");
    expect(result.proposedBy).toBe("rasmus");
    expect(result.proposedAt).toBe("2026-03-05T10:00:00Z");
  });

  it("maps alternatives {name, reason_rejected} → {title, reason}", () => {
    const result = buildAdaptedDecision(baseDecision, [], new Map(), new Map());
    expect(result.alternatives).toEqual([
      { title: "Neo4j", reason: "Operationally heavy" },
      { title: "Postgres", reason: "Server process required" },
    ]);
  });

  it("handles null alternatives (no rows)", () => {
    const result = buildAdaptedDecision(
      { ...baseDecision, alternatives: null },
      [], new Map(), new Map(),
    );
    expect(result.alternatives).toEqual([]);
  });

  it("preserves superseded_by", () => {
    const result = buildAdaptedDecision(
      { ...baseDecision, superseded_by: "dec-old" },
      [], new Map(), new Map(),
    );
    expect(result.supersededBy).toBe("dec-old");
  });
});

describe("buildAdaptedDecisions — governs ref resolution", () => {
  it("resolves a file-path governs link to {kind:'file', path}", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/graph/store.ts",
        relation: "GOVERNS", created_at: "" },
    ];
    const nodes = new Map([
      ["src/graph/store.ts", fileNode("src/graph/store.ts", 3, "graph")],
    ]);
    const frames = new Map([
      ["src/graph/store.ts", { frame_id: 3, frame_label: "graph" }],
    ]);
    const [result] = buildAdaptedDecisions([baseDecision], links, nodes, frames);
    expect(result?.governs).toEqual([
      { kind: "frame", id: "3", label: "graph" },
      { kind: "file", path: "src/graph/store.ts" },
    ]);
  });

  it("resolves a qn-prefix governs link to a frame ref when the file is in a frame", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "qn", target_ref: "src/graph/store.ts::insertNode",
        relation: "GOVERNS", created_at: "" },
    ];
    const nodes = new Map([
      ["src/graph/store.ts", fileNode("src/graph/store.ts", 3, "graph")],
    ]);
    const frames = new Map([
      ["src/graph/store.ts", { frame_id: 3, frame_label: "graph" }],
    ]);
    const [result] = buildAdaptedDecisions([baseDecision], links, nodes, frames);
    expect(result?.governs).toEqual([
      { kind: "frame", id: "3", label: "graph" },
      { kind: "function", path: "src/graph/store.ts", name: "insertNode" },
    ]);
  });

  it("drops links whose target is not in the project (silent)", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/missing.ts",
        relation: "GOVERNS", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.governs).toEqual([]);
  });

  it("ignores non-GOVERNS links when building the governs array", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "decision", target_ref: "dec-other",
        relation: "DECISION_RELATED_TO", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.governs).toEqual([]);
    expect(result?.relatedTo).toEqual(["dec-other"]);
  });

  it("dedupes the frame ref when multiple files in the same frame are governed", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/graph/a.ts",
        relation: "GOVERNS", created_at: "" },
      { decision_id: "dec-1", target_kind: "path", target_ref: "src/graph/b.ts",
        relation: "GOVERNS", created_at: "" },
    ];
    const nodes = new Map([
      ["src/graph/a.ts", fileNode("src/graph/a.ts", 3, "graph")],
      ["src/graph/b.ts", fileNode("src/graph/b.ts", 3, "graph")],
    ]);
    const frames = new Map([
      ["src/graph/a.ts", { frame_id: 3, frame_label: "graph" }],
      ["src/graph/b.ts", { frame_id: 3, frame_label: "graph" }],
    ]);
    const [result] = buildAdaptedDecisions([baseDecision], links, nodes, frames);
    const frameRefs = result?.governs.filter((g) => g.kind === "frame") ?? [];
    expect(frameRefs).toHaveLength(1);
    expect(frameRefs[0]).toEqual({ kind: "frame", id: "3", label: "graph" });
  });
});

describe("buildAdaptedDecisions — related/dependsOn links", () => {
  it("captures DECISION_RELATED_TO targets into relatedTo[]", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "decision", target_ref: "dec-x",
        relation: "DECISION_RELATED_TO", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.relatedTo).toEqual(["dec-x"]);
  });

  it("captures DECISION_DEPENDS_ON targets into dependsOn[]", () => {
    const links: DecisionLink[] = [
      { decision_id: "dec-1", target_kind: "decision", target_ref: "dec-y",
        relation: "DECISION_DEPENDS_ON", created_at: "" },
    ];
    const [result] = buildAdaptedDecisions([baseDecision], links, new Map(), new Map());
    expect(result?.dependsOn).toEqual(["dec-y"]);
  });
});
