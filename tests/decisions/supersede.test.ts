import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DecisionService.supersede", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-sup-"));
    store = new GraphStore(join(dir, "g.db"));
    service = new DecisionService(store);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates new active decision and marks old superseded with link", () => {
    const old = service.create({
      title: "territory hulls",
      description: "d",
      rationale: "r",
      problem: "governance viz",
      resolution: "hulls",
    });
    const next = service.supersede({
      old_decision_id: old.id,
      title: "marginalia",
      problem: "hulls noisy at scale",
      resolution: "pills on focused frame edge",
      rationale: "document metaphor",
    });
    const refreshedOld = service.get(old.id)!;
    const refreshedNew = service.get(next.id)!;
    expect(refreshedNew.status).toBe("active");
    expect(refreshedOld.status).toBe("superseded");
    expect(refreshedOld.superseded_by).toBe(next.id);
  });

  it("throws if old_decision_id does not exist, without partial write", () => {
    expect(() =>
      service.supersede({
        old_decision_id: "nonexistent",
        title: "x",
        problem: "p",
        resolution: "r",
        rationale: "why",
      })
    ).toThrow();
    const dbCount = (store as any).db
      .prepare("SELECT COUNT(*) as c FROM nodes WHERE kind='decision'")
      .get() as { c: number };
    expect(dbCount.c).toBe(0);
  });
});
