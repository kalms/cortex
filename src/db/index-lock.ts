import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Per-repo advisory index lock.
 *
 * Two-layer design:
 *
 * 1. **In-process Promise queue** — a per-path chain of Promises serializes
 *    same-process concurrent callers without ever blocking the JS event loop
 *    (which `better-sqlite3`'s synchronous `BEGIN EXCLUSIVE` would do if two
 *    in-process connections race).
 *
 * 2. **Cross-process SQLite EXCLUSIVE** — once inside the in-process queue, a
 *    `BEGIN EXCLUSIVE` on `<repo>/.cortex/index.lock.db` blocks any *other
 *    process* (e.g. a CLI `cortex index` racing an MCP `index_repository`) with
 *    a 30 s busy_timeout. The OS reclaims the lock on process death (kill -9),
 *    so it can never strand.
 */

// Map from canonical lockPath → tail of the in-process queue.
const _inProcessQueue = new Map<string, Promise<unknown>>();

export async function withIndexLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(repoRoot, ".cortex", "index.lock.db");
  mkdirSync(dirname(lockPath), { recursive: true });

  // --- Layer 1: in-process serialization via promise chain ---
  const prev = _inProcessQueue.get(lockPath) ?? Promise.resolve();

  // `run` is what we actually want to execute once we reach the head of the
  // queue. We capture its Promise so subsequent callers can chain off it.
  let resolveSlot!: () => void;
  const slot = new Promise<void>((r) => { resolveSlot = r; });
  _inProcessQueue.set(lockPath, slot);

  // Wait for every predecessor to finish before entering the critical section.
  await prev.catch(() => { /* predecessor error must not block us */ });

  // --- Layer 2: cross-process SQLite EXCLUSIVE ---
  const db = new BetterSqlite3(lockPath);
  db.pragma("busy_timeout = 30000");
  db.exec("BEGIN EXCLUSIVE");
  try {
    return await fn();
  } finally {
    try { db.exec("COMMIT"); } catch { /* released on close regardless */ }
    db.close();
    // Clean up the map entry when the queue drains to avoid unbounded growth.
    if (_inProcessQueue.get(lockPath) === slot) {
      _inProcessQueue.delete(lockPath);
    }
    resolveSlot();
  }
}
