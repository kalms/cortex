import type { Worker } from 'node:worker_threads';

export interface WorkerSupervisorOpts {
  /** Factory producing a fresh worker. Called on start and on each restart. */
  spawn: () => Worker;
  /** Backoff starts here (ms). */
  initialDelayMs?: number;
  /** Backoff caps here (ms). */
  maxDelayMs?: number;
  /** Called when each new worker is ready (after spawn). Use to (re)initialize. */
  onSpawn?: (worker: Worker) => void;
}

/**
 * Keeps a worker thread alive. Restarts on `error` and `exit` with
 * exponential backoff — 1s, 2s, 4s, capped at 30s by default.
 *
 * The supervisor does NOT preserve events that were in-flight when the
 * worker crashed. Those events are lost (not persisted, not broadcast).
 * Clients see this as a brief quiet period. This is an accepted v1 tradeoff.
 */
export class WorkerSupervisor {
  private worker: Worker | null = null;
  private stopped = false;
  private delay: number;

  constructor(private opts: WorkerSupervisorOpts) {
    this.delay = opts.initialDelayMs ?? 1000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.delay = this.opts.initialDelayMs ?? 1000;
    this.respawn();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }

  current(): Worker | null { return this.worker; }

  private respawn(): void {
    if (this.stopped) return;
    this.worker = this.opts.spawn();
    this.opts.onSpawn?.(this.worker);
    const onDead = () => {
      this.worker = null;
      if (this.stopped) return;
      const wait = this.delay;
      this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 30_000);
      setTimeout(() => this.respawn(), wait);
    };
    this.worker.once('error', onDead);
    this.worker.once('exit', onDead);
  }
}
