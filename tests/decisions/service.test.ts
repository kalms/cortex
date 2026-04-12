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

describe("DecisionService.update", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("updates decision fields", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Original",
      description: "desc",
      rationale: "rationale",
    });

    const updated = service.update(decision.id, {
      title: "Updated Title",
      rationale: "New rationale",
    });

    expect(updated.title).toBe("Updated Title");
    expect(updated.rationale).toBe("New rationale");
    expect(updated.description).toBe("desc");
  });

  it("updates status and superseded_by", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const d1 = service.create({ title: "Old", description: "d", rationale: "r" });
    const d2 = service.create({ title: "New", description: "d", rationale: "r" });

    const updated = service.update(d1.id, {
      status: "superseded",
      superseded_by: d2.id,
    });

    expect(updated.status).toBe("superseded");
    expect(updated.superseded_by).toBe(d2.id);

    const edges = store.findEdges({ source_id: d2.id, target_id: d1.id, relation: "SUPERSEDES" });
    expect(edges).toHaveLength(1);
  });

  it("updates FTS index on update", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "Old keyword",
      description: "desc",
      rationale: "rationale",
    });

    service.update(decision.id, { title: "New keyword" });

    expect(store.searchDecisionContent("Old")).toHaveLength(0);
    expect(store.searchDecisionContent("New")).toHaveLength(1);
  });

  it("throws for non-existent decision", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    expect(() => service.update("fake", { title: "x" })).toThrow("Decision not found");
  });
});

describe("DecisionService.delete", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("deletes a decision and its FTS entry", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const decision = service.create({
      title: "To be deleted",
      description: "desc",
      rationale: "rationale",
    });

    service.delete(decision.id);

    expect(store.getNode(decision.id)).toBeUndefined();
    expect(store.searchDecisionContent("deleted")).toHaveLength(0);
  });

  it("cascade-deletes GOVERNS edges", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const target = store.createNode({ kind: "function", name: "fn" });
    const decision = service.create({
      title: "d1",
      description: "d",
      rationale: "r",
      governs: [target.id],
    });

    service.delete(decision.id);
    expect(store.findEdges({ relation: "GOVERNS" })).toHaveLength(0);
  });
});

describe("DecisionService.get", () => {
  let store: GraphStore;
  let service: DecisionService;

  afterEach(() => {
    store?.close();
  });

  it("returns decision with resolved governs and references", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);

    const fn = store.createNode({ kind: "function", name: "handleReq" });
    const ref = store.createNode({ kind: "reference", name: "JIRA-456" });

    const decision = service.create({
      title: "Request handling",
      description: "desc",
      rationale: "rationale",
      governs: [fn.id],
      references: [ref.id],
    });

    const result = service.get(decision.id);

    expect(result.title).toBe("Request handling");
    expect(result.governs).toHaveLength(1);
    expect(result.governs[0].name).toBe("handleReq");
    expect(result.references).toHaveLength(1);
    expect(result.references[0].name).toBe("JIRA-456");
  });

  it("throws for non-existent decision", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    expect(() => service.get("fake")).toThrow("Decision not found");
  });
});
