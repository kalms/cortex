import { describe, it, expect, afterEach } from "vitest";
import {
  setIndexSignalEmitter,
  emitIndexSignal,
  beginIndexSignal,
} from "../../src/index-signal.js";

afterEach(() => setIndexSignalEmitter(null));

describe("index signal", () => {
  it("is a silent no-op with no emitter installed", () => {
    expect(() => emitIndexSignal({
      type: "index", phase: "started",
      repo_path: "/r", project: "r", branch: "main",
    })).not.toThrow();
  });

  it("emits started immediately and completed with measured elapsed_ms", () => {
    const seen: unknown[] = [];
    setIndexSignalEmitter((m) => seen.push(m));
    const run = beginIndexSignal({ repo_path: "/r", project: "r", branch: "main" });
    run.completed({ nodes: 10, edges: 20, frames: 3 });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: "index", phase: "started", repo_path: "/r", branch: "main" });
    const done = seen[1] as { phase: string; stats: { nodes: number; edges: number; frames: number; elapsed_ms: number } };
    expect(done.phase).toBe("completed");
    expect(done.stats).toMatchObject({ nodes: 10, edges: 20, frames: 3 });
    expect(typeof done.stats.elapsed_ms).toBe("number");
  });

  it("emits completed with elapsed_ms only when no stats are known", () => {
    const seen: Array<{ phase: string; stats?: Record<string, unknown> }> = [];
    setIndexSignalEmitter((m) => seen.push(m as never));
    beginIndexSignal({ repo_path: "/r", project: null, branch: null }).completed();
    expect(seen[1].stats).toEqual({ elapsed_ms: expect.any(Number) });
  });

  it("emits failed with the error text and no stats", () => {
    const seen: Array<{ phase: string; error?: string; stats?: unknown }> = [];
    setIndexSignalEmitter((m) => seen.push(m as never));
    beginIndexSignal({ repo_path: "/r", project: "r", branch: null }).failed("exited 1");
    expect(seen[1]).toMatchObject({ phase: "failed", error: "exited 1" });
    expect(seen[1].stats).toBeUndefined();
  });

  it("swallows an emitter that throws — a broadcast failure must not fail an index", () => {
    setIndexSignalEmitter(() => { throw new Error("socket gone"); });
    expect(() => beginIndexSignal({ repo_path: "/r", project: null, branch: null }).completed()).not.toThrow();
  });
});
