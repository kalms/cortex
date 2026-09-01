import { describe, it, expect, vi } from "vitest";
import { connectLiveSync } from "../../src/viewer/app/ws-client.js";
import { createStore } from "../../src/viewer/app/entity-store.js";

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 1; FakeWS.instances.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.onclose?.(); }
  // test hooks
  open() { this.onopen?.(); }
  recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function harness({ cursor = null, ...rest } = {}) {
  FakeWS.instances = [];
  const store = createStore({ schedule: (fn) => fn() }); // sync flush in tests
  store.hydrate({ decisions: {}, todos: {}, cursor });
  const statuses = [];
  const resnapshot = vi.fn(async (head) => store.setCursor(head));
  const timeouts = [];
  const sync = connectLiveSync({
    wsUrl: "ws://x/ws",
    store,
    isLiveProject: () => true,
    resnapshot,
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWS,
    setTimeoutImpl: (fn, ms) => { timeouts.push({ fn, ms }); return 0; },
    ...rest,
  });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { store, statuses, resnapshot, sync, timeouts, ws: () => FakeWS.instances.at(-1), flush };
}

describe("connectLiveSync", () => {
  it("no cursor → hello triggers resnapshot with head_ulid, then live", async () => {
    const h = harness();
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.resnapshot).toHaveBeenCalledWith("01H");
    expect(h.statuses).toEqual(["syncing", "live"]);
    expect(h.sync.boundProject).toBe("p");
  });

  it("with cursor → hello sends catchup{since}", () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    expect(h.ws().sent).toContainEqual({ type: "catchup", since: "01C" });
    expect(h.statuses).toEqual(["syncing"]);
  });

  it("catchup_result replay applies deltas silently and advances to head", async () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    h.ws().recv({
      type: "catchup_result", mode: "replay", head_ulid: "01H",
      deltas: [{ ulid: "01D", entity: "decision", op: "upsert", data: { id: "d1" } }],
    });
    await Promise.resolve(); await Promise.resolve();
    expect(h.store.state.decisions.d1).toBeDefined();
    expect(h.store.state.cursor).toBe("01H");
    expect(h.statuses.at(-1)).toBe("live");
  });

  it("catchup_result snapshot → resnapshot(head)", async () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    h.ws().recv({ type: "catchup_result", mode: "snapshot", deltas: [], head_ulid: "01H" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.resnapshot).toHaveBeenCalledWith("01H");
  });

  it("live projection deltas apply only for the live project", () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01C" });
    h.ws().recv({ type: "catchup_result", mode: "replay", deltas: [], head_ulid: "01C" });
    h.ws().recv({ type: "projection", delta: { ulid: "01D", entity: "todo", op: "upsert", data: { id: "t1" } } });
    expect(h.store.state.todos.t1).toBeDefined();
  });

  it("close → offline + scheduled reconnect with backoff", () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().close();
    expect(h.statuses.at(-1)).toBe("offline");
    expect(h.timeouts[0].ms).toBe(1000);
    h.timeouts[0].fn();                 // fire reconnect
    expect(FakeWS.instances.length).toBe(2);
    h.ws().close();
    expect(h.timeouts[1].ms).toBe(2000); // backoff grows
  });

  it("projection arriving during in-flight resnapshot is buffered and applied after resnapshot completes", async () => {
    // Use a manually-resolvable resnapshot so we can inject a projection mid-flight.
    FakeWS.instances = [];
    const store = createStore({ schedule: (fn) => fn() });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const statuses = [];
    let resolveResnapshot;
    const resnapshotPromise = new Promise((res) => { resolveResnapshot = res; });
    const resnapshot = vi.fn(async (head) => {
      await resnapshotPromise;
      store.setCursor(head);
    });
    const sync = connectLiveSync({
      wsUrl: "ws://x/ws",
      store,
      isLiveProject: () => true,
      resnapshot,
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeWS,
      setTimeoutImpl: (fn, ms) => 0,
    });
    const ws = FakeWS.instances.at(-1);

    ws.open();
    ws.recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    // Yield so handle() reaches the await inside resnapshot.
    await Promise.resolve();

    // Projection arrives while resnapshot is still in flight.
    ws.recv({ type: "projection", delta: { ulid: "01P", entity: "decision", op: "upsert", data: { id: "d-buffered" } } });

    // Entity must NOT be visible yet — resnapshot is still pending.
    expect(store.state.decisions["d-buffered"]).toBeUndefined();

    // Now resolve the resnapshot and flush all microtasks.
    resolveResnapshot();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Entity must now be present (flushed from buffer after hydrate).
    expect(store.state.decisions["d-buffered"]).toBeDefined();
    expect(statuses).toEqual(["syncing", "live"]);
  });

  it("projection is ignored (no apply, no cursor advance) when isLiveProject returns false", () => {
    FakeWS.instances = [];
    const store = createStore({ schedule: (fn) => fn() });
    store.hydrate({ decisions: {}, todos: {}, cursor: "01C" });
    const statuses = [];
    const resnapshot = vi.fn(async (head) => store.setCursor(head));
    const sync = connectLiveSync({
      wsUrl: "ws://x/ws",
      store,
      isLiveProject: () => false,
      resnapshot,
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeWS,
      setTimeoutImpl: (fn, ms) => 0,
    });
    const ws = FakeWS.instances.at(-1);

    ws.open();
    ws.recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01C" });
    ws.recv({ type: "catchup_result", mode: "replay", deltas: [], head_ulid: "01C" });
    const cursorBefore = store.state.cursor;
    ws.recv({ type: "projection", delta: { ulid: "01P", entity: "todo", op: "upsert", data: { id: "t-ignored" } } });

    expect(store.state.todos["t-ignored"]).toBeUndefined();
    expect(store.state.cursor).toBe(cursorBefore); // cursor must not have advanced
  });

  it("event messages reach onEvent with live:true", async () => {
    const seen = [];
    const h = harness({ onEvent: (e, m) => seen.push([e, m]) }); // extend harness to pass through extra opts
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    await h.flush();
    h.ws().recv({ type: "event", event: { id: "01E", kind: "presence.activity", actor: "claude",
      created_at: 1, project_id: "p", payload: { session_id: "s", workspace: "w", activity: "studied", refs: ["a.ts"] } } });
    expect(seen).toHaveLength(1);
    expect(seen[0][0].kind).toBe("presence.activity");
    expect(seen[0][1]).toEqual({ live: true });
  });

  it("eventBackfill sends backfill after hello and routes the page to onEvent with live:false", async () => {
    const seen = [];
    const h = harness({ onEvent: (e, m) => seen.push(m.live), eventBackfill: { limit: 200 } });
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    await h.flush();
    expect(h.ws().sent).toContainEqual({ type: "backfill", limit: 200 });
    h.ws().recv({ type: "backfill_page", events: [{ id: "01E", kind: "presence.activity", actor: "claude",
      created_at: 1, project_id: "p", payload: {} }], mutations: [], has_more: false });
    expect(seen).toEqual([false]);
  });

  it("no onEvent option → event/backfill_page messages are still ignored (regression)", async () => {
    const h = harness({});
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    await h.flush();
    expect(() => h.ws().recv({ type: "event", event: { kind: "presence.activity" } })).not.toThrow();
  });

  it("hands index messages to onIndex and leaves the store alone", () => {
    const onIndex = vi.fn();
    const h = harness({ cursor: "01C", onIndex });
    h.ws().open();

    h.ws().recv({ type: "index", phase: "started", repo_path: "/tmp/wt", project: "wt", branch: "feat/x" });

    expect(onIndex).toHaveBeenCalledWith(
      expect.objectContaining({ type: "index", phase: "started", repo_path: "/tmp/wt" }),
    );
    // Transient by contract: an index run is not project history.
    expect(h.store.state.cursor).toBe("01C");
  });

  it("ignores an index message when no onIndex is supplied", () => {
    const h = harness();
    h.ws().open();
    expect(() =>
      h.ws().recv({ type: "index", phase: "completed", repo_path: "/r", project: "r", branch: null }),
    ).not.toThrow();
  });
});
