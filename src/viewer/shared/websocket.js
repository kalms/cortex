/**
 * Reconnecting WebSocket client for the 2D viewer.
 *
 * Responsibilities:
 *  - Open a WS connection; re-open with exponential backoff on close.
 *  - Dispatch incoming server messages to per-type callbacks.
 *  - Heartbeat: ping every 30s. Server replies with pong; if we miss responses
 *    (closes), backoff-reconnect.
 *  - On reconnect, send a `backfill` with `before_id = lastSeenEventId` so the
 *    client catches up on events missed during the outage.
 *  - Dedupe events by `id` (server may re-send during backfill).
 */

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
export const HEARTBEAT_MS = 30000;

export function createWsClient({ url, onHello, onEvent, onMutation, onBackfill }) {
  let ws = null;
  let attempt = 0;
  let heartbeatTimer = 0;
  let reconnectTimer = 0;
  let lastSeenId = null;
  const seen = new Set();

  function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      if (lastSeenId) {
        ws.send(JSON.stringify({ type: 'backfill', before_id: lastSeenId, limit: 50 }));
      }
      scheduleHeartbeat();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'hello': onHello(msg); return;
        case 'event': {
          if (msg.event && !seen.has(msg.event.id)) {
            seen.add(msg.event.id);
            lastSeenId = msg.event.id;
            onEvent(msg.event);
          }
          return;
        }
        case 'mutation': onMutation(msg.mutation); return;
        case 'backfill_page': {
          for (const e of msg.events) {
            if (!seen.has(e.id)) {
              seen.add(e.id);
              if (!lastSeenId || e.id > lastSeenId) lastSeenId = e.id;
              onEvent(e);
            }
          }
          onBackfill(msg);
          return;
        }
        case 'pong': return;
      }
    };
    ws.onclose = () => {
      clearTimeout(heartbeatTimer);
      scheduleReconnect();
    };
    ws.onerror = () => { /* close will follow */ };
  }

  function scheduleHeartbeat() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      try { ws && ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    reconnectTimer = setTimeout(open, delay);
  }

  open();

  return {
    close() {
      clearTimeout(heartbeatTimer);
      clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch { /* ignore */ }
    },
  };
}
