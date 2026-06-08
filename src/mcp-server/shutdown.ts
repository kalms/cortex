/**
 * Graceful shutdown orchestration for the stdio MCP server.
 *
 * Why this exists: `src/index.ts` opens an HTTP viewer server, a WS server, and
 * a worker thread, all of which keep the Node event loop alive indefinitely. The
 * stdio MCP server has no natural "I'm done" signal of its own — its lifetime is
 * bound to the parent (Claude Code / VSCode) that owns the stdio pipe. Without an
 * explicit teardown, when the parent goes away (window closed, session ended) the
 * process *lingers* as an orphan still holding `CORTEX_VIEWER_PORT` (default 3333).
 *
 * Orphans holding the fixed viewer port are the root cause of the recurring
 * `ERR_CONNECTION_REFUSED` on http://localhost:3333/viewer after a VSCode
 * restart: the next session races the orphan for the port, gives up after the
 * bounded retry window, and runs viewer-disabled — or lands in the gap where the
 * orphan released the port but the new instance already gave up binding.
 *
 * `createGracefulShutdown` wires a single idempotent teardown that closes every
 * registered resource (best-effort — one failure never blocks the rest) and then
 * exits the process, freeing the port immediately on session end. `index.ts`
 * triggers it from stdin EOF (parent pipe closed) and SIGTERM/SIGINT.
 */

export interface Closable {
  /** Human-readable label, used only for failure logging. */
  name: string;
  /** Release the underlying resource. May be sync or async; may throw/reject. */
  close: () => void | Promise<void>;
}

export interface GracefulShutdownOptions {
  /** Resources to release, torn down in array order. */
  closables: Closable[];
  /** Optional sink for diagnostic lines (defaults to no-op). */
  log?: (msg: string) => void;
  /** Process-exit function (injected for testability). */
  exit: (code: number) => void;
  /**
   * Hard cap, in ms, on the graceful path. If any `close()` hangs past this,
   * force the exit anyway — the freed-port guarantee must not depend on every
   * resource shutting down cleanly. Omit/0 to disable the watchdog.
   */
  forceExitAfterMs?: number;
}

/**
 * Build an idempotent `shutdown(reason)` function.
 *
 * The first invocation closes each closable in registration order — awaiting
 * async closes, swallowing and logging any individual failure so a single
 * stuck/throwing resource can't strand the others — then calls `exit(0)`.
 * Subsequent invocations are no-ops (a server commonly receives both a stdin
 * EOF and a SIGTERM as the parent dies; we must tear down exactly once).
 */
export function createGracefulShutdown(
  opts: GracefulShutdownOptions,
): (reason: string) => Promise<void> {
  const log = opts.log ?? (() => {});
  let started = false;
  let exited = false;

  // Single funnel for the exit call so the graceful path and the watchdog can
  // never both fire it (or fire it twice).
  const finishExit = (via: string): void => {
    if (exited) return;
    exited = true;
    if (via === "watchdog") log(`Cortex: shutdown watchdog fired — forcing exit`);
    opts.exit(0);
  };

  return async function shutdown(reason: string): Promise<void> {
    if (started) return;
    started = true;
    log(`Cortex: shutting down (${reason})`);

    // Watchdog: guarantee exit even if a close() stalls. unref() so the timer
    // itself never keeps the event loop alive.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    if (opts.forceExitAfterMs && opts.forceExitAfterMs > 0) {
      watchdog = setTimeout(() => finishExit("watchdog"), opts.forceExitAfterMs);
      watchdog.unref?.();
    }

    for (const c of opts.closables) {
      try {
        await c.close();
      } catch (e) {
        log(`Cortex: error closing ${c.name} during shutdown: ${(e as Error).message}`);
      }
    }

    if (watchdog) clearTimeout(watchdog);
    finishExit("graceful");
  };
}
