import { describe, it, expect } from "vitest";
import {
  createPresence, colorIdxFor, PRESENCE_HEAT_MS, PRESENCE_FLASH_MS, COLOR_FADE_MS,
  IDLE_MS, GONE_MS, TRAVERSE_SEG_MS, HEAT_BY_ACTIVITY,
} from "../../src/viewer/canvas/presence.js";

const T0 = 100000;

describe("presence state machine", () => {
  it("colorIdxFor is deterministic and in range", () => {
    expect(colorIdxFor("sess-1")).toBe(colorIdxFor("sess-1"));
    expect(colorIdxFor("sess-1")).toBeGreaterThanOrEqual(0);
    expect(colorIdxFor("sess-1")).toBeLessThan(6);
  });

  it("noteActivity registers a session and applies colored trail heat by activity", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "cortex", activity: "edited", frameIds: ["7"], now: T0 });
    const h = p.presenceHeat("7", T0);
    expect(h.trail).toBeCloseTo(HEAT_BY_ACTIVITY.edited, 5);
    expect(h.trailColorIdx).toBe(colorIdxFor("s1"));
    expect(p.presenceHeat("7", T0 + PRESENCE_HEAT_MS + 1)).toBe(0);          // both tiers decayed
    expect(p.presenceHeat("7", T0 + PRESENCE_HEAT_MS / 2).trail).toBeCloseTo(HEAT_BY_ACTIVITY.edited / 2, 2);
  });

  // ── Two-tier heat (fixes the wide-border storm) ──────────────────────────

  it("live first-sighting arrival flashes; flash decays fast, trail slow", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "edited", frameIds: ["1"], now: T0 });
    const h0 = p.presenceHeat("1", T0);
    expect(h0.flash).toBeCloseTo(1, 5);          // live teleport = arrival → flash
    expect(h0.flashColorIdx).toBe(colorIdxFor("s1"));
    expect(h0.trail).toBeCloseTo(1, 5);
    // Flash fully cooled after PRESENCE_FLASH_MS, faint trail still nearly full.
    const h1 = p.presenceHeat("1", T0 + PRESENCE_FLASH_MS + 1);
    expect(h1.flash).toBe(0);
    expect(h1.trail).toBeGreaterThan(0.9);
  });

  it("backfill (animate:false) applies TRAIL only — never flash", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "edited", frameIds: ["1"], now: T0, animate: false });
    const h = p.presenceHeat("1", T0);
    expect(h.trail).toBeGreaterThan(0);
    expect(h.flash).toBe(0);
  });

  it("reducedMotion applies TRAIL only — never flash, even on a move", () => {
    const p = createPresence({ reducedMotion: true });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "edited", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "edited", frameIds: ["2"], now: T0 + 1 });
    expect(p.presenceHeat("1", T0).flash).toBe(0);
    expect(p.presenceHeat("2", T0 + 1).flash).toBe(0);
    expect(p.presenceHeat("2", T0 + 1).trail).toBeGreaterThan(0);
  });

  it("each traversal-segment arrival flashes its hop; a left-behind frame cools in ~6s", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["3"], now: T0 });
    p.setPath("s1", ["1", "2", "3"], T0);
    p.sessions(T0 + 2 * TRAVERSE_SEG_MS + 10);            // run advance() past both hops
    const arr = T0 + 2 * TRAVERSE_SEG_MS;                 // arrival time at "3"
    expect(p.presenceHeat("3", arr + 5).flash).toBeGreaterThan(0.9); // just arrived → hot
    // "1" flashed at T0; ≥ PRESENCE_FLASH_MS later it's flash-cool, trail-only.
    expect(p.presenceHeat("1", T0 + PRESENCE_FLASH_MS + 1).flash).toBe(0);
    expect(p.presenceHeat("1", T0 + PRESENCE_FLASH_MS + 1).trail).toBeGreaterThan(0);
  });

  it("live re-activity on the current frame refreshes the flash (agent stays lit)", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    // Half a flash-life later, re-touch the same frame → flash resets to full.
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 + PRESENCE_FLASH_MS / 2 });
    expect(p.presenceHeat("1", T0 + PRESENCE_FLASH_MS / 2).flash).toBeCloseTo(1, 5);
  });

  // ── Cursor colorAmount fade (prototype v5) ───────────────────────────────

  it("colorAmount is 1 while traversing, then fades over COLOR_FADE_MS after arrival", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["3"], now: T0 });
    p.setPath("s1", ["1", "2", "3"], T0);
    expect(p.sessions(T0 + TRAVERSE_SEG_MS / 2)[0].colorAmount).toBe(1);      // mid-traversal
    const arr = T0 + 2 * TRAVERSE_SEG_MS;
    expect(p.sessions(arr + 10)[0].colorAmount).toBeGreaterThan(0.9);         // just arrived
    expect(p.sessions(arr + COLOR_FADE_MS + 10)[0].colorAmount).toBe(0);      // cooled to neutral
  });

  it("sessions carry targetPath for the dot-level cursor approach", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "edited", frameIds: ["1"], targetPath: "src/a.ts", now: T0 });
    expect(p.sessions(T0)[0].targetPath).toBe("src/a.ts");
  });

  // ── Traversal / roster (unchanged semantics) ─────────────────────────────

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

  it("animate:false (backfill) teleports without traversal but keeps heat + roster", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["5"], now: T0 + 1, animate: false });
    expect(p.pendingTarget("s1")).toBe(null);
    expect(p.sessions(T0 + 1)[0].frameId).toBe("5");       // teleport, no animation
    expect(p.presenceHeat("5", T0 + 1).trail).toBeGreaterThan(0);
  });

  it("reducedMotion collapses traversal to instant arrival but keeps heat + roster", () => {
    const p = createPresence({ reducedMotion: true });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["2"], now: T0 + 1 });
    expect(p.pendingTarget("s1")).toBe(null);
    expect(p.sessions(T0 + 1)[0].frameId).toBe("2");
    expect(p.presenceHeat("2", T0 + 1).trail).toBeGreaterThan(0);
  });

  it("empty frameIds updates lastSeen only", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "consulted", frameIds: [], now: T0 });
    expect(p.roster(T0)).toHaveLength(1);
    expect(p.sessions(T0)[0].frameId).toBe(null);
  });

  it("synapses tolerate non-monotonic query time: skip not-yet-started, preserve in-flight", () => {
    const p = createPresence();
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["1"], now: T0 });
    p.noteActivity({ sessionId: "s1", workspace: "w", activity: "studied", frameIds: ["3"], now: T0 });
    p.setPath("s1", ["1", "2", "3"], T0);
    // Query before the first synapse has started (t < 0)
    expect(p.synapses(T0 - 100)).toHaveLength(0);
    // Query during the first segment (should still see the pulse)
    expect(p.synapses(T0 + TRAVERSE_SEG_MS / 2)).toHaveLength(1);
  });
});
