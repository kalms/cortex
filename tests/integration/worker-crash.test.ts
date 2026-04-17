import { describe, it, expect, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { WorkerSupervisor } from '../../src/events/worker-supervisor.js';

let sup: WorkerSupervisor | null = null;
afterEach(async () => { await sup?.stop(); sup = null; });

describe('WorkerSupervisor', () => {
  it('restarts the worker after it crashes', async () => {
    let spawns = 0;
    sup = new WorkerSupervisor({
      spawn: () => {
        spawns++;
        return new Worker(`process.exit(${spawns === 1 ? 1 : 0})`, { eval: true });
      },
      initialDelayMs: 10,
      maxDelayMs: 100,
    });
    await sup.start();

    await new Promise((r) => setTimeout(r, 500));
    expect(spawns).toBeGreaterThanOrEqual(2);
  });

  it('applies exponential backoff between restarts', async () => {
    const starts: number[] = [];
    sup = new WorkerSupervisor({
      spawn: () => {
        starts.push(Date.now());
        return new Worker('process.exit(1)', { eval: true });
      },
      initialDelayMs: 20,
      maxDelayMs: 200,
    });
    await sup.start();
    await new Promise((r) => setTimeout(r, 400));
    await sup.stop();

    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    // Later gaps should not be smaller than earlier ones (backoff grows).
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] * 0.9);
    }
  });
});
