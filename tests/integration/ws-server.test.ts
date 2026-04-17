import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startWsServer } from '../../src/ws/server.js';
import type { ServerMsg, Event } from '../../src/ws/types.js';
import type { EventPersister } from '../../src/events/worker/persister.js';

let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

function fakePersister(): EventPersister {
  return {
    backfill: ({ limit = 50 } = {}) => ({
      events: [] as Event[],
      has_more: false,
    }),
  } as unknown as EventPersister;
}

async function startServer(persister: EventPersister) {
  const httpServer = createServer();
  const { registry } = startWsServer({
    httpServer,
    persister,
    projectId: 'p',
    serverVersion: '0.2.0',
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;
  closers.push(() => new Promise((r) => httpServer.close(() => r())));
  return { port, registry };
}

describe('WebSocket server', () => {
  it('sends hello on connect', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const hello = await new Promise<ServerMsg>((resolve) => {
      ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString())));
    });
    expect(hello).toEqual({ type: 'hello', project_id: 'p', server_version: '0.2.0' });
    ws.close();
  });

  it('responds to ping with pong', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    // Drain hello
    await new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(pong).toEqual({ type: 'pong' });
    ws.close();
  });

  it('serves backfill_page in response to backfill request', async () => {
    const persister = {
      backfill: () => ({
        events: [{
          id: '01HXZ000000000000000000AA',
          kind: 'decision.created',
          actor: 'claude',
          created_at: 1,
          project_id: 'p',
          payload: { decision_id: 'd', title: 't', rationale: 'r', governed_file_ids: [], tags: [] },
        } as Event],
        has_more: false,
      }),
    } as unknown as EventPersister;

    const { port } = await startServer(persister);
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello
    ws.send(JSON.stringify({ type: 'backfill', limit: 50 }));
    const page = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(page.type).toBe('backfill_page');
    if (page.type === 'backfill_page') {
      expect(page.events).toHaveLength(1);
      expect(page.has_more).toBe(false);
    }
    ws.close();
  });

  it('replies with error on malformed client message without disconnecting', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello
    ws.send('not json');
    const err = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(err.type).toBe('error');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
