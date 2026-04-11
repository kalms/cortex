import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService.create", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("creates a basic decision", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Use PostgreSQL",
      description: "We need a relational database",
      rationale: "PostgreSQL supports JSONB and has strong ecosystem",
    });

    expect(decision.id).toBeDefined();
    expect(decision.title).toBe("Use PostgreSQL");
    expect(decision.description).toBe("We need a relational database");
    expect(decision.rationale).toBe("PostgreSQL supports JSONB and has strong ecosystem");
    expect(decision.status).toBe("active");
    expect(decision.tier).toBe("personal");
    expect(decision.alternatives).toEqual([]);
  });

  it("creates a decision with alternatives", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Use PostgreSQL",
      description: "Database choice",
      rationale: "Best fit",
      alternatives: [
        { name: "MySQL", reason_rejected: "Weaker JSON support" },
        { name: "MongoDB", reason_rejected: "Need relational queries" },
      ],
    });

    expect(decision.alternatives).toHaveLength(2);
    expect(decision.alternatives[0].name).toBe("MySQL");
  });

  it("creates GOVERNS edges to existing nodes", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const target = store.createNode({
      kind: "function",
      name: "dbConnect",
      qualified_name: "src/db.ts::dbConnect",
    });

    const decision = service.create({
      title: "Use connection pooling",
      description: "desc",
      rationale: "rationale",
      governs: [target.id],
    });

    const edges = store.findEdges({ source_id: decision.id, relation: "GOVERNS" });
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe(target.id);
  });

  it("creates path nodes for file path governs targets", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "API routing structure",
      description: "desc",
      rationale: "rationale",
      governs: ["src/api/routes/"],
    });

    const edges = store.findEdges({ source_id: decision.id, relation: "GOVERNS" });
    expect(edges).toHaveLength(1);

    const pathNode = store.getNode(edges[0].target_id);
    expect(pathNode).toBeDefined();
    expect(pathNode!.kind).toBe("path");
    expect(pathNode!.file_path).toBe("src/api/routes/");
  });

  it("creates REFERENCES edges", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const ref = store.createNode({ kind: "reference", name: "JIRA-123" });

    const decision = service.create({
      title: "d1",
      description: "desc",
      rationale: "rationale",
      references: [ref.id],
    });

    const edges = store.findEdges({ source_id: decision.id, relation: "REFERENCES" });
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe(ref.id);
  });

  it("indexes decision in FTS", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    service.create({
      title: "Use Redis for caching",
      description: "Need a fast cache layer",
      rationale: "Redis supports TTL",
    });

    const results = store.searchDecisionContent("caching");
    expect(results).toHaveLength(1);
  });
});
