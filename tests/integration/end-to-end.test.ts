import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import WebSocket from 'ws';
import { GraphStore } from '../../src/graph/store.js';
import { DecisionService } from '../../src/decisions/service.js';
import { EventBus } from '../../src/events/bus.js';
import { EventPersister } from '../../src/events/worker/persister.js';
import { startWsServer } from '../../src/ws/server.js';
import type { ServerMsg } from '../../src/ws/types.js';

/**
 * End-to-end wiring test: DecisionService mutation → EventBus → worker →
 * WS broadcast → connected client receives the event.
 *
 * Exercises the same topology that `src/index.ts` builds in production:
 *   DecisionService --emit--> EventBus --forward--> Worker (persist + derive)
 *                                                       |
 *                                                  broadcast bundle
 *                                                       v
 *                                               WsServer.broadcast
 *                                                       v
 *                                              WebSocket client
 *
 * Note: this is about WIRING, not mutation correctness. The worker's mutation
 * deriver only produces `add_node` when the node already exists in its
 * snapshot. Since we create the decision AFTER init, the first broadcast
 * carries the event but no mutations. Mutation emission is covered by
 * tests/events/mutation-deriver.test.ts and tests/integration/events-flow.test.ts.
 */

let closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Close in reverse order (LIFO): ws client before http server, worker
  // before persister, etc. httpServer.close() blocks on open client
  // connections, so the ws client must be closed first.
  for (const c of [...closers].reverse()) {
    try {
      await c();
    } catch {
      // Ignore cleanup errors — they cascade from intentional early teardown.
    }
  }
  closers = [];
});

describe('end-to-end: decision → event + mutations over WS', () => {
  it('client receives event after a decision is created', async () => {
    const store = new GraphStore(':memory:');
    closers.push(() => store.close());

    const persister = new EventPersister(':memory:');
    closers.push(() => persister.close());

    const bus = new EventBus();

    // Reuse the test bootstrap from Task 7.
    const worker = new Worker(
      new URL('./worker-bootstrap.mjs', import.meta.url),
      { execArgv: [] },
    );
    closers.push(() => worker.terminate());

    // Initialize worker and wait for ready.
    await new Promise<void>((resolve) => {
      const handler = (msg: { type: string }) => {
        if (msg.type === 'ready') {
          worker.off('message', handler);
          resolve();
        }
      };
      worker.on('message', handler);
      worker.postMessage({
        type: 'init',
        events_db_path: ':memory:',
        project_id: 'test',
        nodes: [],
      });
    });

    // Spin up HTTP + WS server on an ephemeral port.
    const httpServer = createServer();
    await new Promise<void>((r) => httpServer.listen(0, r));
    closers.push(
      () => new Promise<void>((r) => httpServer.close(() => r())),
    );
    const port = (httpServer.address() as { port: number }).port;

    const { broadcast } = startWsServer({
      httpServer,
      persister,
      projectId: 'test',
      serverVersion: '0.2.0',
    });

    // Wire worker broadcast → WS broadcast.
    worker.on('message', (msg) => {
      if (msg.type === 'broadcast') broadcast(msg.bundle);
    });

    // Wire bus → worker.
    bus.onEvent((e) => worker.postMessage({ type: 'event', event: e }));

    const service = new DecisionService(store, { bus, project_id: 'test' });

    // Connect WS client and capture messages.
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    closers.push(
      () =>
        new Promise<void>((r) => {
          if (
            ws.readyState === WebSocket.CLOSED ||
            ws.readyState === WebSocket.CLOSING
          ) {
            r();
            return;
          }
          ws.once('close', () => r());
          ws.close();
        }),
    );

    const received: ServerMsg[] = [];
    await new Promise((r) => ws.once('open', r));
    ws.on('message', (d: Buffer) => received.push(JSON.parse(d.toString())));

    // Drain hello message (WsServer delays hello by ~5ms).
    await new Promise((r) => setTimeout(r, 50));

    // Trigger the mutation. Event flows: service → bus → worker → broadcast → WS.
    const d = service.create({
      title: 't',
      description: '',
      rationale: 'r',
      governs: [],
    });

    // Push updated snapshot so any future mutations could derive (not required
    // for this assertion since we only check the event).
    const nodes = store.getAllNodesUnified();
    worker.postMessage({ type: 'snapshot_update', nodes });

    // Wait for event message to propagate through the chain.
    await new Promise((r) => setTimeout(r, 200));

    const eventMsg = received.find((m) => m.type === 'event');
    expect(eventMsg).toBeDefined();
    if (eventMsg?.type === 'event') {
      expect(eventMsg.event.kind).toBe('decision.created');
      if (eventMsg.event.kind === 'decision.created') {
        expect(eventMsg.event.payload.decision_id).toBe(d.id);
      }
    }
  });
});
