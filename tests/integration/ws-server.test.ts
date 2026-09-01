import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startWsServer } from '../../src/ws/server.js';
import type { WsServerOpts } from '../../src/ws/server.js';
import type { ServerMsg, Event, ProjectionDelta, IndexSignalMsg } from '../../src/ws/types.js';
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
    since: ({ since_id: _since_id, limit: _limit } = {} as { since_id: string; limit: number }) => ({
      events: [] as Event[],
      has_more: false,
    }),
    head: () => null,
  } as unknown as EventPersister;
}

async function startServer(
  persister: EventPersister,
  opts?: Pick<WsServerOpts, 'deriveProjections'>,
) {
  const httpServer = createServer();
  const handle = startWsServer({
    httpServer,
    persister,
    projectId: 'p',
    serverVersion: '0.2.0',
    ...opts,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;
  closers.push(() => new Promise((r) => httpServer.close(() => r())));
  return { port, registry: handle.registry, handle };
}

describe('WebSocket server', () => {
  it('sends hello on connect', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const hello = await new Promise<ServerMsg>((resolve) => {
      ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString())));
    });
    expect(hello).toEqual({ type: 'hello', project_id: 'p', server_version: '0.2.0', head_ulid: null });
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
      head: () => null,
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

  it('bad catchup.since shape gets bad_message reply; connection stays open', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello

    // Send malformed catchup (since is an object — would crash better-sqlite3 without fix)
    ws.send(JSON.stringify({ type: 'catchup', since: {} }));
    const err = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(err.type).toBe('error');
    if (err.type === 'error') expect(err.code).toBe('bad_message');
    // Connection must still be alive — send a ping and expect pong
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(pong.type).toBe('pong');
    ws.close();
  });

  it('hello carries head_ulid', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const hello = await new Promise<ServerMsg>((resolve) => {
      ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString())));
    });
    expect(hello.type).toBe('hello');
    if (hello.type === 'hello') {
      expect(hello.head_ulid === null || typeof hello.head_ulid === 'string').toBe(true);
    }
    ws.close();
  });

  it('broadcastProjections fans a projection message to clients', async () => {
    const { port, handle } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello

    const delta: ProjectionDelta = {
      ulid: '01J0000000000000000000000A',
      entity: 'decision',
      op: 'upsert',
      data: { id: 'd1' },
    };
    handle.broadcastProjections([delta]);
    const msg = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(msg).toMatchObject({ type: 'projection', delta: { entity: 'decision', op: 'upsert' } });
    ws.close();
  });

  it('broadcastIndex fans an index message out and persists nothing', async () => {
    // A real write would go through persister.insert, and would move the head
    // cursor. Both are asserted untouched: "transient" is the whole point.
    const inserted: Event[] = [];
    const persister = {
      ...fakePersister(),
      insert: (e: Event) => { inserted.push(e); },
      head: () => null,
    } as unknown as EventPersister;

    const { port, handle } = await startServer(persister);
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello

    const signal: IndexSignalMsg = {
      type: 'index',
      phase: 'completed',
      repo_path: '/tmp/wt',
      project: 'tmp-wt',
      branch: 'feature/x',
      stats: { nodes: 10, edges: 20, frames: 3, elapsed_ms: 1500 },
    };
    handle.broadcastIndex(signal);

    const msg = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(msg).toMatchObject({
      type: 'index',
      phase: 'completed',
      repo_path: '/tmp/wt',
      branch: 'feature/x',
      stats: { nodes: 10, elapsed_ms: 1500 },
    });
    expect(inserted).toEqual([]);
    expect(persister.head()).toBeNull();
    ws.close();
  });

  it('catchup within the window replays derived deltas', async () => {
    // Seed a persister with two events
    const firstId = '01J0000000000000000000001A';
    const secondId = '01J0000000000000000000002A';
    const baseEvent: Event = {
      id: firstId,
      kind: 'decision.created',
      actor: 'claude',
      created_at: 1,
      project_id: 'p',
      payload: { decision_id: 'd1', title: 't', rationale: 'r', governed_file_ids: [], tags: [] },
    } as Event;
    const secondEvent: Event = {
      ...baseEvent,
      id: secondId,
    };

    // Fake persister that returns only the event(s) after since_id
    const persister: EventPersister = {
      backfill: () => ({ events: [], has_more: false }),
      since: ({ since_id }: { since_id: string; limit: number }) => {
        const all = [baseEvent, secondEvent];
        const events = all.filter((e) => e.id > since_id);
        return { events, has_more: false };
      },
      head: () => secondId,
    } as unknown as EventPersister;

    const deriveProjections = (events: Event[]): ProjectionDelta[] =>
      events.map((e) => ({ ulid: e.id, entity: 'decision' as const, op: 'upsert' as const, data: { id: 'x' } }));

    const { port } = await startServer(persister, { deriveProjections });
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello

    ws.send(JSON.stringify({ type: 'catchup', since: firstId }));
    const msg = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(msg.type).toBe('catchup_result');
    if (msg.type === 'catchup_result') {
      expect(msg.mode).toBe('replay');
      // Only the event AFTER firstId (i.e. secondEvent) should be returned
      expect(msg.deltas.length).toBe(1);
      expect(msg.head_ulid).toBe(secondId);
    }
    ws.close();
  });

  it('catchup past the 500-delta window responds mode:snapshot with empty deltas', async () => {
    const firstId = '01J0000000000000000000001A';
    const secondId = '01J0000000000000000000002A';

    // Persister that always reports has_more = true (simulating > 500 events)
    const realSinceResult = { events: [] as Event[], has_more: false };
    const persister: EventPersister = {
      backfill: () => ({ events: [], has_more: false }),
      since: (_opts: { since_id: string; limit: number }) => ({
        ...realSinceResult,
        has_more: true,
      }),
      head: () => secondId,
    } as unknown as EventPersister;

    const { port } = await startServer(persister);
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello

    ws.send(JSON.stringify({ type: 'catchup', since: firstId }));
    const msg = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(msg.type).toBe('catchup_result');
    if (msg.type === 'catchup_result') {
      expect(msg.mode).toBe('snapshot');
      expect(msg.deltas).toEqual([]);
    }
    ws.close();
  });
});
