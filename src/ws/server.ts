import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { encodeServer, decodeClient } from './protocol.js';
import { ClientRegistry } from './client-registry.js';
import type { ServerMsg, Event, GraphMutation, ProjectionDelta, IndexSignalMsg } from './types.js';
import type { EventPersister } from '../events/worker/persister.js';

/** Catch-up replay window (spec: snapshot-vs-replay threshold). A client whose
 *  cursor is further behind than this re-snapshots instead of replaying. */
export const CATCHUP_REPLAY_LIMIT = 500;

/** Options passed to startWsServer. */
export interface WsServerOpts {
  httpServer: HttpServer;
  persister: EventPersister;
  projectId: string;
  serverVersion: string;
  /** Injected by the composition root (src/index.ts) — maps events to
   *  projection deltas at catch-up time. Optional: without it, catchup always
   *  answers mode:'snapshot' (safe degraded mode). */
  deriveProjections?: (events: Event[]) => ProjectionDelta[];
}

/**
 * Handle returned by startWsServer.
 *
 * `registry` is exposed so the caller can inspect connected clients (e.g.,
 * for tests). `broadcast` is the primary call-site — main calls this when
 * the worker posts a broadcast bundle. `broadcastProjections` fans out
 * projection deltas to all connected clients.
 */
export interface WsServerHandle {
  registry: ClientRegistry;
  broadcast(bundle: { events: Event[]; mutations: GraphMutation[] }): void;
  broadcastProjections(deltas: ProjectionDelta[]): void;
  /** Transient index lifecycle. Fans out to every client regardless of the
   *  server's bound projectId — index runs concern arbitrary checkouts, and
   *  the client filters on `repo_path`. */
  broadcastIndex(msg: IndexSignalMsg): void;
}

/**
 * Starts a WebSocket server bound to the provided HTTP server's upgrade event
 * at path `/ws`.
 *
 * Per-connection lifecycle:
 *   1. Upgrade completes → server sends `hello`.
 *   2. Client may send `backfill` or `ping` at any time.
 *   3. Server sends `event` + `mutation` messages as the worker posts
 *      broadcast bundles. Call `broadcast()` on the returned handle.
 *
 * Error handling mirrors the spec: malformed messages get an error reply,
 * connection stays open. Send failures evict the client.
 */
export function startWsServer(opts: WsServerOpts): WsServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const registry = new ClientRegistry();

  opts.httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      registry.add(ws);
      ws.on('close', () => registry.remove(ws));

      // 5ms timer is a test-reliability measure, not a production concern.
      // In same-process usage (tests), the ws lib delivers the upgrade response
      // and immediately-following frames in the same socket.readable callback.
      // setImmediate / setTimeout(0) are insufficient — the client's `open`
      // event fires asynchronously on a loopback socket, and a `message` listener
      // registered in that handler is sometimes too late to catch a frame sent
      // synchronously after handleUpgrade. A short timer breaks the ordering and
      // guarantees hello arrives in a separate I/O cycle after the client has
      // had time to register its listener.
      // TODO: investigate a proper fix (possibly a client-side "ready" handshake).
      setTimeout(() => {
        send(ws, {
          type: 'hello',
          project_id: opts.projectId,
          server_version: opts.serverVersion,
          head_ulid: opts.persister.head(),
        });
      }, 5);

      ws.on('message', (raw: RawData) => {
        const str = Buffer.isBuffer(raw)
          ? raw.toString()
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString()
            : Buffer.from(raw).toString();
        handleClient(ws, str, opts);
      });
    });
  });

  return {
    registry,
    broadcast(bundle: { events: Event[]; mutations: GraphMutation[] }) {
      for (const event of bundle.events) {
        registry.broadcast(encodeServer({ type: 'event', event }));
      }
      for (const mutation of bundle.mutations) {
        registry.broadcast(encodeServer({ type: 'mutation', mutation }));
      }
    },
    broadcastProjections(deltas: ProjectionDelta[]) {
      for (const delta of deltas) {
        registry.broadcast(encodeServer({ type: 'projection', delta }));
      }
    },
    broadcastIndex(msg: IndexSignalMsg) {
      registry.broadcast(encodeServer(msg));
    },
  };
}

function handleClient(ws: WebSocket, raw: string, opts: WsServerOpts): void {
  let msg;
  try { msg = decodeClient(raw); }
  catch (e) {
    send(ws, { type: 'error', code: 'bad_message', message: (e as Error).message });
    return;
  }
  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong' });
      return;
    case 'backfill': {
      const { events, has_more } = opts.persister.backfill({
        before_id: msg.before_id,
        limit: msg.limit,
      });
      send(ws, {
        type: 'backfill_page',
        events,
        // Backfill carries events only. The viewer hydrates the graph from
        // /api/graph on connect, which returns the full current state —
        // replaying historical mutations on top of that would double-apply.
        // Mutations field preserved in the protocol for symmetry with live
        // `mutation` messages; always empty for backfill_page.
        mutations: [],
        has_more,
      });
      return;
    }
    case 'catchup': {
      const head_ulid = opts.persister.head();
      const { events, has_more } = opts.persister.since({
        since_id: msg.since,
        limit: CATCHUP_REPLAY_LIMIT,
      });
      if (has_more || !opts.deriveProjections) {
        send(ws, { type: 'catchup_result', mode: 'snapshot', deltas: [], head_ulid });
      } else {
        send(ws, {
          type: 'catchup_result',
          mode: 'replay',
          deltas: opts.deriveProjections(events),
          head_ulid,
        });
      }
      return;
    }
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeServer(msg));
}
