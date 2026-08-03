import { describe, it, expect } from "vitest";
import { createLiveEffects, BIRTH_MS, HALO_MS, LEADER_MS, REMOVE_MS, HEAT_DECAY_MS } from "../../src/viewer/canvas/live-effects.js";

const base = { entity: "decision", id: "d1", frameIds: ["7"], actor: "claude" };

describe("createLiveEffects", () => {
  it("create → birth progresses 0→1 over BIRTH_MS then null", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "create", now: 1000 });
    expect(fx.birth("d1", 1000)).toBe(0);
    expect(fx.birth("d1", 1000 + BIRTH_MS / 2)).toBeCloseTo(0.5);
    expect(fx.birth("d1", 1000 + BIRTH_MS + 1)).toBeNull();
  });

  it("update → halo drains linearly over HALO_MS; re-fire restarts at max", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "update", now: 0 });
    expect(fx.haloLift("d1", 0)).toBe(1);
    expect(fx.haloLift("d1", HALO_MS / 2)).toBeCloseTo(0.5);
    fx.noteChange({ ...base, kind: "update", now: HALO_MS / 2 });
    expect(fx.haloLift("d1", HALO_MS / 2)).toBe(1);   // restart, not additive
    expect(fx.haloLift("d1", HALO_MS * 2)).toBe(0);
  });

  it("leader boost is a triangular peak over LEADER_MS", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "update", now: 0 });
    expect(fx.leaderBoost("d1", 0)).toBe(0);
    expect(fx.leaderBoost("d1", LEADER_MS / 2)).toBeCloseTo(1);
    expect(fx.leaderBoost("d1", LEADER_MS)).toBeCloseTo(0);
    expect(fx.leaderBoost("d1", LEADER_MS + 100)).toBe(0);
  });

  it("frame heat saturates and decays over HEAT_DECAY_MS", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "update", now: 0 });
    expect(fx.frameHeat("7", 0)).toBeCloseTo(0.5);
    fx.noteChange({ ...base, id: "d2", kind: "update", now: 0 });
    expect(fx.frameHeat("7", 0)).toBe(1);              // capped
    expect(fx.frameHeat("7", HEAT_DECAY_MS / 2)).toBeCloseTo(0.5);
    expect(fx.frameHeat("7", HEAT_DECAY_MS + 1)).toBe(0);
  });

  it("remove → tombstone at last recorded pos, evicted after REMOVE_MS", () => {
    const fx = createLiveEffects();
    fx.recordDotPos("d1", 100, 200);
    fx.noteChange({ ...base, kind: "remove", now: 0 });
    const t0 = fx.tombstones(0);
    expect(t0).toEqual([{ id: "d1", entity: "decision", x: 100, y: 200, t: 0 }]);
    expect(fx.tombstones(REMOVE_MS + 1)).toEqual([]);
  });

  it("pills carry attribution: claude → agent glyph pill, others → @user", () => {
    const fx = createLiveEffects();
    fx.recordDotPos("d1", 1, 2);
    fx.noteChange({ ...base, kind: "update", now: 0 });
    fx.recordDotPos("t9", 3, 4);
    fx.noteChange({ entity: "todo", id: "t9", frameIds: [], actor: "rka", kind: "update", now: 0 });
    const pills = fx.pills(0);
    expect(pills.find((p) => p.id === "d1")).toMatchObject({ name: "claude", isUser: false });
    expect(pills.find((p) => p.id === "t9")).toMatchObject({ name: "@rka", isUser: true });
    expect(fx.pills(HALO_MS + 1)).toEqual([]);
  });

  it("same-actor burst collapses to ONE pill riding the latest change", () => {
    const fx = createLiveEffects();
    fx.recordDotPos("t1", 10, 20);
    fx.recordDotPos("t2", 30, 40);
    fx.noteChange({ ...base, entity: "todo", id: "t1", kind: "create", now: 0 });
    fx.noteChange({ ...base, entity: "todo", id: "t2", kind: "create", now: 100 });
    const pills = fx.pills(100);
    expect(pills.length).toBe(1);
    expect(pills[0]).toMatchObject({ id: "t2", x: 30, y: 40, name: "claude", alpha: 1 });
    // A different actor still gets their own pill alongside.
    fx.noteChange({ entity: "todo", id: "t1", frameIds: [], actor: "rka", kind: "update", now: 100 });
    expect(fx.pills(100).length).toBe(2);
  });

  // ── isActive: the render loop's "still settling?" probe ──────────────────

  it("isActive is false on a fresh instance", () => {
    const fx = createLiveEffects();
    expect(fx.isActive(0)).toBe(false);
  });

  it("isActive: false → true after noteChange → false once every window elapses", () => {
    const fx = createLiveEffects();
    expect(fx.isActive(0)).toBe(false);
    fx.noteChange({ ...base, kind: "update", now: 1000 });
    expect(fx.isActive(1000)).toBe(true);                       // halo + leader + heat + pill live
    expect(fx.isActive(1000 + LEADER_MS + 1)).toBe(true);       // leader done, halo/heat/pill remain
    // Longest windows here are HALO_MS (halo + pill) and HEAT_DECAY_MS (heat).
    const allDone = 1000 + Math.max(HALO_MS, HEAT_DECAY_MS) + 1;
    // Stale pills report active for one pass until a pills() query self-cleans.
    expect(fx.isActive(allDone)).toBe(true);
    fx.pills(allDone);
    expect(fx.isActive(allDone)).toBe(false);
  });

  it("isActive does not rely on a prior query having pruned the maps", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "create", now: 0 });
    // No birth()/leaderBoost()/frameHeat() queries in between: the maps still
    // hold entries, but every window has elapsed → not active (pills excepted,
    // which need one self-clean pass).
    const late = Math.max(HALO_MS, HEAT_DECAY_MS) + 1;
    fx.pills(late); // clear the attribution pill
    expect(fx.isActive(late)).toBe(false);
  });

  it("isActive covers a remove's tombstone window", () => {
    const fx = createLiveEffects();
    fx.recordDotPos("d1", 1, 2);
    fx.noteChange({ ...base, kind: "remove", now: 0 });
    fx.pills(HALO_MS + 1); // drop the attribution pill so only the tombstone could hold it
    expect(fx.isActive(REMOVE_MS - 1)).toBe(true);
    expect(fx.isActive(Math.max(HALO_MS, HEAT_DECAY_MS) + 1)).toBe(false);
  });

  it("isActive under reducedMotion tracks only the pills", () => {
    const fx = createLiveEffects({ reducedMotion: true });
    expect(fx.isActive(0)).toBe(false);
    fx.noteChange({ ...base, kind: "update", now: 0 });
    expect(fx.isActive(0)).toBe(true);
    fx.pills(2001); // REDUCED_PILL_MS elapsed → query self-cleans
    expect(fx.isActive(2001)).toBe(false);
  });

  it("reducedMotion collapses motion but keeps attribution pills", () => {
    const fx = createLiveEffects({ reducedMotion: true });
    fx.recordDotPos("d1", 1, 2);
    fx.noteChange({ ...base, kind: "create", now: 0 });
    expect(fx.birth("d1", 0)).toBeNull();
    expect(fx.haloLift("d1", 0)).toBe(0);
    expect(fx.frameHeat("7", 0)).toBe(0);
    expect(fx.pills(0).length).toBe(1);
    expect(fx.pills(2001)).toEqual([]);
  });
});
