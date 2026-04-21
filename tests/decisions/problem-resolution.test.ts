import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DecisionService — problem + resolution", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;
  let search: DecisionSearch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-"));
    store = new GraphStore(join(dir, "g.db"));
    service = new DecisionService(store);
    search = new DecisionSearch(store);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("create persists problem + resolution in data JSON", () => {
    const d = service.create({
      title: "LOD",
      description: "legacy",
      rationale: "why",
      problem: "unreadable at zoom",
      resolution: "band projection",
      alternatives: [],
    });
    expect(d.problem).toBe("unreadable at zoom");
    expect(d.resolution).toBe("band projection");

    const fetched = service.get(d.id);
    expect(fetched?.problem).toBe("unreadable at zoom");
    expect(fetched?.resolution).toBe("band projection");
  });

  it("existing decisions without problem/resolution read null", () => {
    // Simulate legacy row — write directly via store
    const raw = store.createNode({
      kind: "decision",
      name: "Old",
      data: { description: "d", rationale: "r" },
    });
    const fetched = service.get(raw.id);
    expect(fetched?.problem).toBeNull();
    expect(fetched?.resolution).toBeNull();
  });

  it("update replaces problem + resolution", () => {
    const d = service.create({
      title: "LOD",
      description: "legacy",
      rationale: "why",
      problem: "old problem",
      resolution: "old resolution",
    });
    const u = service.update(d.id, { problem: "new problem", resolution: "new resolution" });
    expect(u.problem).toBe("new problem");
    expect(u.resolution).toBe("new resolution");
  });

  it("search matches on problem field", () => {
    service.create({
      title: "LOD",
      description: "legacy",
      rationale: "why",
      problem: "unreadable at zoom",
      resolution: "band projection",
    });
    const hits = search.search("unreadable");
    expect(hits.length).toBe(1);
  });
});
