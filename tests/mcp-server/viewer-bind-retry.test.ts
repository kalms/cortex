import { describe, it, expect } from "vitest";
import { bindWithRetry } from "../../src/mcp-server/api.js";

const eaddrinuse = (): NodeJS.ErrnoException => {
  const e: NodeJS.ErrnoException = new Error("listen EADDRINUSE: address already in use :::3333");
  e.code = "EADDRINUSE";
  return e;
};

/** Build an attempt() that fails `failures` times with EADDRINUSE, then binds. */
function flakyBinder(failures: number) {
  let calls = 0;
  const attempt = async () => {
    calls++;
    if (calls <= failures) return { ok: false as const, error: eaddrinuse() };
    return { ok: true as const };
  };
  return { attempt, calls: () => calls };
}

const noSleep = async () => {};

describe("bindWithRetry", () => {
  it("binds on the first attempt with no retry logging", async () => {
    const logs: string[] = [];
    const b = flakyBinder(0);
    const ok = await bindWithRetry(b.attempt, { port: 3333, retries: 5, delayMs: 1, log: (m) => logs.push(m), sleep: noSleep });
    expect(ok).toBe(true);
    expect(b.calls()).toBe(1);
    expect(logs.filter((l) => l.includes("retrying"))).toHaveLength(0);
  });

  it("retries a busy port and succeeds once it frees, logging each attempt", async () => {
    const logs: string[] = [];
    const b = flakyBinder(2);
    const ok = await bindWithRetry(b.attempt, { port: 3333, retries: 5, delayMs: 1, log: (m) => logs.push(m), sleep: noSleep });
    expect(ok).toBe(true);
    expect(b.calls()).toBe(3); // 2 failures + 1 success
    const retryLogs = logs.filter((l) => l.includes("retrying"));
    expect(retryLogs).toHaveLength(2);
    expect(retryLogs[0]).toContain("3333");
    expect(retryLogs[0]).toContain("1/5");
  });

  it("gives up after exhausting retries and logs a final failure", async () => {
    const logs: string[] = [];
    const b = flakyBinder(Infinity);
    const ok = await bindWithRetry(b.attempt, { port: 3333, retries: 3, delayMs: 1, log: (m) => logs.push(m), sleep: noSleep });
    expect(ok).toBe(false);
    expect(b.calls()).toBe(4); // initial + 3 retries
    expect(logs.some((l) => /FAILED to bind/.test(l) && l.includes("3333"))).toBe(true);
  });

  it("does not retry a non-EADDRINUSE error — fails fast and logs it", async () => {
    const logs: string[] = [];
    let calls = 0;
    const attempt = async () => {
      calls++;
      const e: NodeJS.ErrnoException = new Error("EACCES: permission denied");
      e.code = "EACCES";
      return { ok: false as const, error: e };
    };
    const ok = await bindWithRetry(attempt, { port: 80, retries: 5, delayMs: 1, log: (m) => logs.push(m), sleep: noSleep });
    expect(ok).toBe(false);
    expect(calls).toBe(1); // no retries on a non-contention error
    expect(logs.some((l) => /FAILED to bind/.test(l) && l.includes("EACCES"))).toBe(true);
  });
});
