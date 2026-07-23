import { describe, it, expect } from "vitest";
import {
  createPresence, colorIdxFor, PRESENCE_HEAT_MS, IDLE_MS, GONE_MS, TRAVERSE_SEG_MS, HEAT_BY_ACTIVITY,
} from "../../src/viewer/canvas/presence.js";

const T0 = 100000;

describe("presence state machine", () => {
  it("colorIdxFor is deterministic and in range", () => {
    expect(colorIdxFor("sess-1")).toBe(colorIdxFor("sess-1"));
    expect(colorIdxFor("sess-1")).toBeGreaterThanOrEqual(0);
    expect(colorIdxFor("sess-1")).toBeLessThan(6);
  });

  it("noteActivity registers a session and applies colored heat by activity", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "cortex", activity: "edited", frameIds: ["7"], now: T0 });
    const h = p.presenceHeat("7", T0);
    expect(h.value).toBeCloseTo(HEAT_BY_ACTIVITY.edited, 5);
    expect(h.colorIdx).toBe(colorIdxFor("s1"));
    expect(p.presenceHeat("7", T0 + PRESENCE_HEAT_MS + 1)).toBe(0);          // fully decayed
    expect(p.presenceHeat("7", T0 + PRESENCE_HEAT_MS / 2).value).toBeCloseTo(HEAT_BY_ACTIVITY.edited / 2, 2);
  });

  it("first activity arrives instantly; second sets a pending target", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    expect(p.sessions(T0)[0].frameId).toBe("1");           // no prior position → instant arrival
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["3"], now: T0 + 10 });
    expect(p.pendingTarget("s1")).toEqual({ fromFrameId: "1", toFrameId: "3" });
  });

  it("setPath animates segment-by-segment and fires synapses", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["3"], now: T0 });
    p.setPath("s1", ["1", "2", "3"], T0);
    expect(p.pendingTarget("s1")).toBe(null);
    const mid = p.sessions(T0 + TRAVERSE_SEG_MS / 2)[0];
    expect(mid.seg.fromFrameId).toBe("1");
    expect(mid.seg.toFrameId).toBe("2");
    expect(mid.seg.t).toBeGreaterThan(0); expect(mid.seg.t).toBeLessThan(1);
    expect(p.synapses(T0 + TRAVERSE_SEG_MS / 2)).toHaveLength(1);
    const done = p.sessions(T0 + 2 * TRAVERSE_SEG_MS + 50)[0];
    expect(done.seg).toBe(null);
    expect(done.frameId).toBe("3");
  });

  it("burst coalescing: latest target wins, no queue growth", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["2"], now: T0 + 1 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["9"], now: T0 + 2 });
    expect(p.pendingTarget("s1").toFrameId).toBe("9");
  });

  it("idle after IDLE_MS, gone after GONE_MS", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    expect(p.roster(T0 + IDLE_MS - 1)[0].idle).toBe(false);
    expect(p.roster(T0 + IDLE_MS + 1)[0].idle).toBe(true);
    expect(p.roster(T0 + GONE_MS + 1)).toHaveLength(0);
    expect(p.sessions(T0 + GONE_MS + 1)).toHaveLength(0);
  });

  it("animate:false (backfill) applies heat + roster without traversal", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["5"], now: T0 + 1, animate: false });
    expect(p.pendingTarget("s1")).toBe(null);
    expect(p.sessions(T0 + 1)[0].frameId).toBe("5");       // teleport, no animation
    expect(p.presenceHeat("5", T0 + 1).value).toBeGreaterThan(0);
  });

  it("reducedMotion collapses traversal to instant arrival but keeps heat + roster", () => {
    const p = createPresence({ reducedMotion: true });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["2"], now: T0 + 1 });
    expect(p.pendingTarget("s1")).toBe(null);
    expect(p.sessions(T0 + 1)[0].frameId).toBe("2");
    expect(p.presenceHeat("2", T0 + 1).value).toBeGreaterThan(0);
  });

  it("empty frameIds updates lastSeen only", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "consulted", frameIds: [], now: T0 });
    expect(p.roster(T0)).toHaveLength(1);
    expect(p.sessions(T0)[0].frameId).toBe(null);
  });
});
