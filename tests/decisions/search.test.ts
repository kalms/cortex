import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";

describe("DecisionSearch.search", () => {
  let store: GraphStore;
  let service: DecisionService;
  let search: DecisionSearch;

  afterEach(() => {
    store?.close();
  });

  it("finds decisions by keyword", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    service.create({ title: "Use Redis for caching", description: "Cache layer needed", rationale: "Fast" });
    service.create({ title: "Use PostgreSQL", description: "Database choice", rationale: "Relational" });

    const results = search.search("caching");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Use Redis for caching");
  });

  it("scopes search to governed entities", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    const fn = store.createNode({
      kind: "function",
      name: "dbConnect",
      qualified_name: "src/db.ts::dbConnect",
    });

    service.create({
      title: "Connection pooling strategy",
      description: "Pool database connections",
      rationale: "Performance",
      governs: [fn.id],
    });

    service.create({
      title: "API pooling strategy",
      description: "Pool API connections",
      rationale: "Performance",
    });

    const scoped = search.search("pooling", "src/db.ts::dbConnect");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].title).toBe("Connection pooling strategy");
  });

  it("returns empty array for no matches", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    expect(search.search("nonexistent")).toHaveLength(0);
  });
});

describe("DecisionSearch.whyWasThisBuilt", () => {
  let store: GraphStore;
  let service: DecisionService;
  let search: DecisionSearch;

  afterEach(() => {
    store?.close();
  });

  it("finds decisions governing a specific entity by qualified_name", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    const fn = store.createNode({
      kind: "function",
      name: "validate",
      qualified_name: "src/auth/validate.ts::validate",
      file_path: "src/auth/validate.ts",
    });

    service.create({
      title: "Input validation approach",
      description: "d",
      rationale: "r",
      governs: [fn.id],
    });

    const results = search.whyWasThisBuilt("src/auth/validate.ts::validate");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Input validation approach");
  });

  it("walks up to file path when no direct QN match", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    service.create({
      title: "Auth module design",
      description: "d",
      rationale: "r",
      governs: ["src/auth/"],
    });

    const results = search.whyWasThisBuilt("src/auth/validate.ts");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Auth module design");
  });

  it("walks up directory hierarchy", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    service.create({
      title: "Source structure",
      description: "d",
      rationale: "r",
      governs: ["src/"],
    });

    const results = search.whyWasThisBuilt("src/auth/middleware/jwt.ts");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Source structure");
  });

  it("returns empty when nothing governs the entity", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    search = new DecisionSearch(store);

    expect(search.whyWasThisBuilt("src/unrelated.ts")).toHaveLength(0);
  });
});
