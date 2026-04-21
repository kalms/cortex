import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DecisionService relations", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-rel-"));
    store = new GraphStore(join(dir, "g.db"));
    service = new DecisionService(store);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("linkRelatedTo + linkDependsOn create edges and appear in getWithRefs", () => {
    const a = service.create({ title: "A", description: "d", rationale: "r", problem: "p", resolution: "res" });
    const b = service.create({ title: "B", description: "d", rationale: "r", problem: "p", resolution: "res" });
    const c = service.create({ title: "C", description: "d", rationale: "r", problem: "p", resolution: "res" });

    service.linkRelatedTo(a.id, b.id);
    service.linkDependsOn(a.id, c.id);

    const view = service.getWithRefs(a.id)!;
    expect(view.related_decisions.map((d) => d.id).sort()).toEqual([b.id].sort());
    expect(view.depends_on.map((d) => d.id).sort()).toEqual([c.id].sort());
  });
});
