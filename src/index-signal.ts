/**
 * Index lifecycle emitter — a module-level singleton installed by the
 * composition root (`src/index.ts`) and left null everywhere else.
 *
 * A singleton rather than injected params because the two emit sites sit deep
 * inside per-call tool handlers with no DI channel between them and the ws
 * handle. Null in tests and in the CLI, where the emit is a no-op — the same
 * posture `presence` takes in the API.
 */
import type { IndexSignalMsg } from './events/types.js';

type Emitter = (msg: IndexSignalMsg) => void;

let emitter: Emitter | null = null;

export function setIndexSignalEmitter(fn: Emitter | null): void {
  emitter = fn;
}

export function emitIndexSignal(msg: IndexSignalMsg): void {
  if (!emitter) return;
  try {
    emitter(msg);
  } catch {
    // A broadcast failure must never fail the index that triggered it.
  }
}

/**
 * Bracket one index run. Emits `started` now; the returned callbacks emit the
 * terminal phase with `elapsed_ms` measured here, so every completion carries
 * a duration even when the underlying path reports no counts.
 */
export function beginIndexSignal(o: {
  repo_path: string;
  project: string | null;
  branch: string | null;
}): {
  completed(stats?: { nodes?: number; edges?: number; frames?: number }): void;
  failed(error: string): void;
} {
  const startedAt = Date.now();
  emitIndexSignal({ type: 'index', phase: 'started', ...o });
  return {
    completed(stats) {
      emitIndexSignal({
        type: 'index', phase: 'completed', ...o,
        stats: { ...stats, elapsed_ms: Date.now() - startedAt },
      });
    },
    failed(error) {
      emitIndexSignal({ type: 'index', phase: 'failed', ...o, error });
    },
  };
}
