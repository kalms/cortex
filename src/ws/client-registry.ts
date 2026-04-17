/**
 * WebSocket-like interface that ClientRegistry depends on. Mirrors the real
 * `ws` library's WebSocket class enough for fan-out and lifecycle.
 * Typed loose so tests can substitute a plain object.
 */
interface WsLike {
  send(data: string): void;
  close(): void;
  readyState: number;
}

const OPEN = 1;

/**
 * In-memory set of connected WebSocket clients with fan-out broadcast.
 *
 * Lives on the main thread. The worker thread never touches this — it sends
 * prepared broadcast payloads to main via postMessage, and main calls
 * `broadcast(payload)` here.
 *
 * If a `send` throws or the client is not OPEN, the client is evicted and
 * closed. Keeps the registry from growing unbounded when clients disappear
 * without a proper close event.
 */
export class ClientRegistry {
  private clients = new Set<WsLike>();

  add(ws: WsLike): void {
    this.clients.add(ws);
  }

  remove(ws: WsLike): void {
    this.clients.delete(ws);
  }

  size(): number {
    return this.clients.size;
  }

  broadcast(payload: string): void {
    for (const client of [...this.clients]) {
      if (client.readyState !== OPEN) { this.evict(client); continue; }
      try {
        client.send(payload);
      } catch {
        this.evict(client);
      }
    }
  }

  forEachOpen(fn: (ws: WsLike) => void): void {
    for (const c of this.clients) {
      if (c.readyState === OPEN) fn(c);
    }
  }

  private evict(ws: WsLike): void {
    this.clients.delete(ws);
    try { ws.close(); } catch { /* ignore */ }
  }
}
