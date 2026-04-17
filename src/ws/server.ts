import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { encodeServer, decodeClient } from './protocol.js';
import { ClientRegistry } from './client-registry.js';
import type { ServerMsg, Event, GraphMutation } from './types.js';
import type { EventPersister } from '../events/worker/persister.js';

export interface WsServerOpts {
  httpServer: HttpServer;
  persister: EventPersister;
  projectId: string;
  serverVersion: string;
}

export interface WsServerHandle {
  registry: ClientRegistry;
  broadcast(bundle: { events: Event[]; mutations: GraphMutation[] }): void;
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

      // Defer hello by 1 ms so the client always receives it in a separate
      // readable event from the upgrade response. When both endpoints share
      // the same event loop (test / same-process usage), the ws library
      // processes the upgrade response and any immediately-following frames
      // in a single socket.on('readable') callback, so a timer (not just
      // setImmediate or setTimeout(0)) is needed to guarantee the hello
      // arrives AFTER the client's `open` handler has run and the caller has
      // had a chance to register a `message` listener.
      setTimeout(() => {
        send(ws, {
          type: 'hello',
          project_id: opts.projectId,
          server_version: opts.serverVersion,
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
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeServer(msg));
}
