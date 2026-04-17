import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Event, GraphMutation } from '../../src/events/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function sampleEvent(): Event {
  return {
    id: '01HXZ0000000000000000000EE',
    kind: 'decision.created',
    actor: 'claude',
    created_at: Date.now(),
    project_id: 'test',
    payload: {
      decision_id: 'd1',
      title: 't',
      rationale: 'r',
      governed_file_ids: ['f1'],
      tags: [],
    },
  } as Event;
}

describe('worker events flow', () => {
  it('accepts events, persists, derives mutations, posts broadcast bundle back', async () => {
    /**
     * On Node 23, tsx's IPC-based resolve hook (which maps .js → .ts) doesn't
     * propagate into worker threads because the worker's tsx instance cannot
     * connect to the parent's esbuild server (it uses process.ppid which points
     * to the grandparent process, not the main thread's tsx server).
     *
     * The bootstrap wrapper registers tsx's ESM loader directly inside the
     * worker via module.register(), bypassing the IPC pipe entirely.
     * This is the approach that works on Node 23 + tsx 4.x.
     */
    const worker = new Worker(
      new URL('./worker-bootstrap.mjs', import.meta.url),
      { execArgv: [] },
    );

    const bundles: { events: Event[]; mutations: GraphMutation[] }[] = [];
    worker.on('message', (msg) => {
      if (msg.type === 'broadcast') bundles.push(msg.bundle);
    });

    // Handshake: tell the worker to use :memory: and a snapshot with node d1/f1.
    worker.postMessage({
      type: 'init',
      events_db_path: ':memory:',
      project_id: 'test',
      nodes: [
        { id: 'd1', kind: 'decision', name: 't', status: 'active' },
        { id: 'f1', kind: 'file', name: 'f1.ts' },
      ],
    });

    // Wait for ready
    await new Promise<void>((resolve) => {
      const handler = (msg: { type: string }) => {
        if (msg.type === 'ready') {
          worker.off('message', handler);
          resolve();
        }
      };
      worker.on('message', handler);
    });

    worker.postMessage({ type: 'event', event: sampleEvent() });

    // Give the worker a tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bundles).toHaveLength(1);
    expect(bundles[0].events).toHaveLength(1);
    expect(bundles[0].mutations.length).toBeGreaterThan(0);
    expect(bundles[0].mutations[0].op).toBe('add_node');

    await worker.terminate();
  });
});
