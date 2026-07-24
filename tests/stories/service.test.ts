import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { StoryService } from "../../src/stories/service.js";

const mkDb = () => openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-svc-st-")), "d.db"));

describe("StoryService", () => {
  it("create mints an S- id + seq 1, persists ordered steps, and returns steps in order", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({
      title: "Pipeline tour",
      created_by: "claude",
      steps: [
        { caption: "Entry", refs: ["src/index.ts"] },
        { caption: "Worker", refs: ["src/events/worker/persister.ts"], layout_hint: "network" },
      ],
      links: { decision_ids: ["D-zwrt"], pr_number: 62 },
    });
    expect(s.id).toMatch(/^S-[0-9a-z]{4}$/);
    expect(s.seq).toBe(1);
    expect(s.steps.map((x) => x.step_index)).toEqual([1, 2]);
    expect(s.steps[0]).toMatchObject({ caption: "Entry", refs: ["src/index.ts"], layout_hint: null });
    expect(s.steps[1]).toMatchObject({ caption: "Worker", refs: ["src/events/worker/persister.ts"], layout_hint: "network" });
    expect(s.status).toBe("open");
    expect(s.step_count).toBe(2);
    db.close();
  });

  it("create with closed: true creates status closed", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({ title: "Already done", closed: true, steps: [{ caption: "Only", refs: [] }] });
    expect(s.status).toBe("closed");
    db.close();
  });

  it("create persists links as story_links rows (decision x n, pr, relation ABOUT)", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({
      title: "Linked",
      steps: [{ caption: "Only", refs: [] }],
      links: { decision_ids: ["D-zwrt", "D-aaaa"], pr_number: 62 },
    });
    const rows = db.prepare("SELECT target_kind, target_ref, relation FROM story_links WHERE story_id = ?").all(s.id) as Array<{
      target_kind: string;
      target_ref: string;
      relation: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.target_kind === "decision").map((r) => r.target_ref).sort()).toEqual(["D-aaaa", "D-zwrt"]);
    expect(rows.filter((r) => r.target_kind === "pr")).toEqual([{ target_kind: "pr", target_ref: "62", relation: "ABOUT" }]);
    for (const r of rows) expect(r.relation).toBe("ABOUT");
    db.close();
  });

  it("create throws 'story requires at least one step' on empty steps", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    expect(() => svc.create({ title: "Empty", steps: [] })).toThrow("story requires at least one step");
    db.close();
  });

  it("get resolves both seq form (S-1) and canonical form", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({ title: "Resolvable", steps: [{ caption: "Only", refs: [] }] });
    expect(svc.get("S-1")?.id).toBe(s.id);
    expect(svc.get(s.id)?.id).toBe(s.id);
    expect(svc.get("S-zzzz")).toBeNull();
    db.close();
  });

  it("list() carries step_count and orders by created_at DESC", () => {
    vi.useFakeTimers();
    try {
      const db = mkDb();
      const svc = new StoryService({ db });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const a = svc.create({ title: "A", steps: [{ caption: "1", refs: [] }] });
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      const b = svc.create({ title: "B", steps: [{ caption: "1", refs: [] }, { caption: "2", refs: [] }] });
      const list = svc.list();
      expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
      expect(list.find((x) => x.id === b.id)?.step_count).toBe(2);
      expect(list.find((x) => x.id === a.id)?.step_count).toBe(1);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close flips status to closed and is idempotent", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({ title: "Closable", steps: [{ caption: "Only", refs: [] }] });
    const closed = svc.close(s.id);
    expect(closed.status).toBe("closed");
    const closedAgain = svc.close(s.id);
    expect(closedAgain.status).toBe("closed");
    db.close();
  });

  it("close throws 'Story not found: X' for unknown refs", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    expect(() => svc.close("S-zzzz")).toThrow("Story not found: S-zzzz");
    db.close();
  });

  it("delete returns true then false", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({ title: "Deletable", steps: [{ caption: "Only", refs: [] }] });
    expect(svc.delete(s.id)).toBe(true);
    expect(svc.delete(s.id)).toBe(false);
    db.close();
  });

  it("checkAdvance passes for a valid open, in-range call and returns resolved story", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({ title: "Advance", steps: [{ caption: "1", refs: [] }, { caption: "2", refs: [] }] });
    const result = svc.checkAdvance(s.id, 2);
    expect(result.id).toBe(s.id);
    expect(result.steps).toHaveLength(2);
    // also resolves via seq form
    expect(svc.checkAdvance("S-1", 1).id).toBe(s.id);
    db.close();
  });

  it("checkAdvance throws 'Story not found: X' for unknown refs", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    expect(() => svc.checkAdvance("S-zzzz", 1)).toThrow("Story not found: S-zzzz");
    db.close();
  });

  it("checkAdvance throws 'Story S-x is closed' for a closed story, using resolved canonical id", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({ title: "Closes", steps: [{ caption: "1", refs: [] }] });
    svc.close(s.id);
    expect(() => svc.checkAdvance(s.id, 1)).toThrow(`Story ${s.id} is closed`);
  db.close();
  });

  it("checkAdvance throws 'Step N out of range (story has M steps)'", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({ title: "Ranged", steps: [{ caption: "1", refs: [] }, { caption: "2", refs: [] }] });
    expect(() => svc.checkAdvance(s.id, 3)).toThrow("Step 3 out of range (story has 2 steps)");
    db.close();
  });

  it("representative brief scenario end-to-end", () => {
    const db = mkDb();
    const svc = new StoryService({ db });
    const s = svc.create({
      title: "Pipeline tour",
      created_by: "claude",
      steps: [
        { caption: "Entry", refs: ["src/index.ts"] },
        { caption: "Worker", refs: ["src/events/worker/persister.ts"], layout_hint: "network" },
      ],
      links: { decision_ids: ["D-zwrt"], pr_number: 62 },
    });
    expect(s.id).toMatch(/^S-[0-9a-z]{4}$/);
    expect(s.seq).toBe(1);
    expect(s.steps.map((x) => x.step_index)).toEqual([1, 2]);
    expect(svc.get("S-1")?.id).toBe(s.id);
    expect(() => svc.checkAdvance(s.id, 3)).toThrow("out of range");
    svc.close(s.id);
    expect(() => svc.checkAdvance(s.id, 1)).toThrow("closed");
    expect(() => svc.checkAdvance("S-zzzz", 1)).toThrow("not found");
    db.close();
  });
});
