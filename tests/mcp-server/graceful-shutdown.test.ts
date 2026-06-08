import { describe, it, expect, vi } from "vitest";
import { createGracefulShutdown } from "../../src/mcp-server/shutdown.js";

describe("createGracefulShutdown", () => {
  it("closes every closable in registration order, then exits 0", async () => {
    const order: string[] = [];
    let exitCode: number | null = null;
    const shutdown = createGracefulShutdown({
      closables: [
        { name: "http", close: () => void order.push("http") },
        { name: "ws", close: () => void order.push("ws") },
        { name: "store", close: () => void order.push("store") },
      ],
      exit: (code) => void (exitCode = code),
    });

    await shutdown("stdin-close");

    expect(order).toEqual(["http", "ws", "store"]);
    expect(exitCode).toBe(0);
  });

  it("is idempotent — a second call neither re-closes nor re-exits", async () => {
    let closes = 0;
    let exits = 0;
    const shutdown = createGracefulShutdown({
      closables: [{ name: "http", close: () => void closes++ }],
      exit: () => void exits++,
    });

    await shutdown("SIGTERM");
    await shutdown("stdin-close");

    expect(closes).toBe(1);
    expect(exits).toBe(1);
  });

  it("continues past a closable that throws and still exits 0 (best-effort)", async () => {
    const order: string[] = [];
    let exitCode: number | null = null;
    const logs: string[] = [];
    const shutdown = createGracefulShutdown({
      closables: [
        { name: "http", close: () => void order.push("http") },
        { name: "ws", close: () => { throw new Error("ws boom"); } },
        { name: "store", close: () => void order.push("store") },
      ],
      log: (m) => logs.push(m),
      exit: (code) => void (exitCode = code),
    });

    await shutdown("SIGINT");

    expect(order).toEqual(["http", "store"]); // ws threw but didn't abort the rest
    expect(exitCode).toBe(0);
    expect(logs.some((l) => /ws/.test(l) && /boom/.test(l))).toBe(true);
  });

  it("awaits async closables before exiting", async () => {
    const order: string[] = [];
    let exitCode: number | null = null;
    const shutdown = createGracefulShutdown({
      closables: [
        {
          name: "worker",
          close: async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push("worker");
          },
        },
      ],
      exit: (code) => void (exitCode = code),
    });

    await shutdown("stdin-close");

    expect(order).toEqual(["worker"]);
    expect(exitCode).toBe(0);
  });

  it("forces exit via the watchdog when a close() hangs past forceExitAfterMs", async () => {
    vi.useFakeTimers();
    try {
      let exits = 0;
      const shutdown = createGracefulShutdown({
        forceExitAfterMs: 3000,
        closables: [
          // Never resolves — simulates worker.terminate() stalling.
          { name: "stuck", close: () => new Promise<void>(() => {}) },
        ],
        exit: () => void exits++,
      });

      void shutdown("stdin-close");
      expect(exits).toBe(0); // still hung
      await vi.advanceTimersByTimeAsync(3000);
      expect(exits).toBe(1); // watchdog forced it
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not double-exit when graceful completion and watchdog both could fire", async () => {
    let exits = 0;
    const shutdown = createGracefulShutdown({
      forceExitAfterMs: 50,
      closables: [{ name: "fast", close: () => {} }],
      exit: () => void exits++,
    });

    await shutdown("stdin-close"); // graceful path finishes immediately, clears watchdog
    await new Promise((r) => setTimeout(r, 80)); // give the (cleared) watchdog time to NOT fire
    expect(exits).toBe(1);
  });
});
