// src/viewer/ws-client.js
/**
 * Reconnecting read-path sync client. Feeds ProjectionDeltas from /ws into
 * the store; on (re)connect runs the bootstrap/catch-up protocol:
 *
 *   hello{head_ulid} → no cursor  → resnapshot(head) (snapshot bootstrap)
 *                    → have cursor → catchup{since} → replay | snapshot
 *
 * Catch-up applies with animate:false (spec: silent catch-up — no burst of
 * stale change treatments after a laptop wake). Live deltas animate only when
 * the tab is visible. Deltas for a project other than the server-bound one
 * are ignored WITHOUT advancing the cursor, so switching back catches up.
 * Backoff mirrors the worker supervisor: 1s → 2s → 4s … capped at 30s.
 */

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Transient index lifecycle message. `stats` is best-effort — a cache import
 * knows no node/edge counts and a detached background index reports none at
 * all — but `elapsed_ms` is always measured.
 *
 * @typedef {{
 *   type: 'index',
 *   phase: 'started' | 'completed' | 'failed',
 *   repo_path: string,
 *   project: string | null,
 *   branch: string | null,
 *   stats?: { nodes?: number, edges?: number, frames?: number, elapsed_ms: number },
 *   error?: string,
 * }} IndexSignalMsg
 */

export function connectLiveSync({
  wsUrl,
  store,
  isLiveProject,
  resnapshot,
  onStatus,
  onEvent,
  onIndex = /** @type {((msg: IndexSignalMsg) => void)|null} */ (null),
  eventBackfill = /** @type {{limit:number}|null} */ (null),
  WebSocketImpl = globalThis.WebSocket,
  retryDelays = DEFAULT_RETRY_DELAYS,
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
}) {
  let ws = null;
  let attempt = 0;
  let closed = false;
  // Buffer projections that arrive while a resnapshot is in flight so they are
  // not silently lost. Deltas carry full adapted entity state and upserts are
  // idempotent, so flushing after hydrate converges correctly whether or not
  // the snapshot already included the write.
  let resnapshotting = false;
  let buffered = [];
  const api = { boundProject: null, close };

  function status(s) { onStatus?.(s); }

  function animateNow() {
    return typeof document === "undefined" ? true : document.visibilityState === "visible";
  }

  function connect() {
    if (closed) return;
    ws = new WebSocketImpl(wsUrl);
    ws.onopen = () => { /* wait for hello */ };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => {
      if (closed) return;
      status("offline");
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
      attempt += 1;
      setTimeoutImpl(connect, delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  async function handle(msg) {
    switch (msg.type) {
      case "hello": {
        attempt = 0;
        api.boundProject = msg.project_id || null;
        status("syncing");
        if (store.state.cursor === null) {
          resnapshotting = true;
          try {
            await resnapshot(msg.head_ulid);
          } finally {
            resnapshotting = false;
            for (const d of buffered.splice(0)) store.apply(d, { animate: false });
          }
          status("live");
        } else {
          ws.send(JSON.stringify({ type: "catchup", since: store.state.cursor }));
        }
        if (eventBackfill && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "backfill", limit: eventBackfill.limit }));
        }
        return;
      }
      case "catchup_result": {
        if (msg.mode === "replay") {
          for (const delta of msg.deltas) store.apply(delta, { animate: false });
          if (msg.head_ulid) store.setCursor(msg.head_ulid);
        } else {
          resnapshotting = true;
          try {
            await resnapshot(msg.head_ulid);
          } finally {
            resnapshotting = false;
            for (const d of buffered.splice(0)) store.apply(d, { animate: false });
          }
        }
        status("live");
        return;
      }
      case "projection": {
        if (!isLiveProject()) return; // ignored deltas don't advance the cursor — catch-up covers them
        if (resnapshotting) { buffered.push(msg.delta); return; }
        store.apply(msg.delta, { animate: animateNow() });
        return;
      }
      case "event": {
        if (onEvent) onEvent(msg.event, { live: true });
        return;
      }
      case "backfill_page": {
        if (onEvent && eventBackfill) for (const e of msg.events) onEvent(e, { live: false });
        return;
      }
      case "index": {
        // Transient by contract: no store write, no cursor movement. The
        // message concerns some checkout, not necessarily the bound project,
        // so the consumer decides what an index of that path means to it.
        if (onIndex) onIndex(msg);
        return;
      }
      default:
        return; // mutation / pong — other consumers' channels
    }
  }

  function close() {
    closed = true;
    try { ws?.close(); } catch { /* already closed */ }
  }

  connect();
  return api;
}
