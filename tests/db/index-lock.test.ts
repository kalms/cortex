import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withIndexLock } from "../../src/db/index-lock.js";

describe("withIndexLock", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("runs the critical section and returns its result", async () => {
    dir = mkdtempSync(join(tmpdir(), "lock-"));
    mkdirSync(join(dir, ".cortex"));
    const out = await withIndexLock(dir, async () => 42);
    expect(out).toBe(42);
  });

  it("serializes overlapping holders (second waits for the first)", async () => {
    dir = mkdtempSync(join(tmpdir(), "lock-"));
    mkdirSync(join(dir, ".cortex"));
    const order: string[] = [];
    const a = withIndexLock(dir, async () => { order.push("a-start"); await new Promise(r => setTimeout(r, 50)); order.push("a-end"); });
    const b = withIndexLock(dir, async () => { order.push("b"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("releases the lock even if the critical section throws", async () => {
    dir = mkdtempSync(join(tmpdir(), "lock-"));
    mkdirSync(join(dir, ".cortex"));
    await expect(withIndexLock(dir, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // A subsequent acquisition must succeed (lock was released).
    const out = await withIndexLock(dir, async () => "ok");
    expect(out).toBe("ok");
  });
});
