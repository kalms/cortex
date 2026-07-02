import { describe, it, expect, vi } from "vitest";
import { connectLiveSync } from "../../src/viewer/ws-client.js";
import { createStore } from "../../src/viewer/store.js";

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.instances.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.onclose?.(); }
  // test hooks
  open() { this.onopen?.(); }
  recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function harness({ cursor = null } = {}) {
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
  });
  return { store, statuses, resnapshot, sync, timeouts, ws: () => FakeWS.instances.at(-1) };
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
});
