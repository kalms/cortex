import { describe, it, expect } from "vitest";
import { createStore } from "../../src/viewer/app/entity-store.js";

// Manual scheduler: collects flush callbacks; run() executes them.
function manualScheduler() {
  const q = [];
  const schedule = (fn) => q.push(fn);
  const run = () => { while (q.length) q.shift()(); };
  return { schedule, run };
}

const d = (ulid, id, extra = {}) =>
  ({ ulid, entity: "decision", op: "upsert", data: { id, summary: "s", ...extra } });

describe("createStore", () => {
  it("hydrate fills state and preserves object identity", () => {
    const { schedule } = manualScheduler();
    const store = createStore({ schedule });
    const decisionsRef = store.state.decisions;
    store.hydrate({ decisions: { d1: { id: "d1" } }, todos: {}, cursor: "01A" });
    expect(store.state.decisions).toBe(decisionsRef); // same object, mutated in place
    expect(store.state.decisions.d1.id).toBe("d1");
    expect(store.state.cursor).toBe("01A");
    expect(store.hydrated).toBe(true);
  });

  it("apply upserts, advances the cursor, and flushes once for a burst", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const flushes = [];
    store.subscribe((changes) => flushes.push(changes));
    store.apply(d("01B", "d1"));
    store.apply(d("01C", "d1", { summary: "s2" }));
    store.apply(d("01D", "d2"));
    run();
    expect(flushes.length).toBe(1);                    // coalesced
    expect(flushes[0].length).toBe(2);                 // d1 (last wins) + d2
    expect(store.state.decisions.d1.summary).toBe("s2");
    expect(store.state.cursor).toBe("01D");
  });

  it("drops deltas at or below the cursor (reconnect overlap)", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: "01C" });
    store.apply(d("01B", "stale"));
    run();
    expect(store.state.decisions.stale).toBeUndefined();
  });

  it("remove deletes and reports prev; removing an absent id is a no-op", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: { d1: { id: "d1" } }, todos: {}, cursor: null });
    const flushes = [];
    store.subscribe((c) => flushes.push(c));
    store.apply({ ulid: "01B", entity: "decision", op: "remove", data: { id: "d1" } });
    store.apply({ ulid: "01C", entity: "decision", op: "remove", data: { id: "ghost" } });
    run();
    expect(store.state.decisions.d1).toBeUndefined();
    const changes = flushes.flat();
    expect(changes.length).toBe(1);                    // ghost removal not reported
    expect(changes[0]).toMatchObject({ op: "remove", id: "d1", prev: { id: "d1" } });
    expect(store.state.cursor).toBe("01C");            // cursor still advances
  });

  it("create vs update is distinguishable via prev", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const changes = [];
    store.subscribe((c) => changes.push(...c));
    store.apply(d("01B", "d1"));
    run();
    store.apply(d("01C", "d1", { summary: "v2" }));
    run();
    expect(changes[0].prev).toBeUndefined();           // create
    expect(changes[1].prev).toMatchObject({ id: "d1" }); // update
  });

  it("queues deltas that arrive before hydrate and replays them after", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.apply(d("01B", "d1"), { animate: true });
    expect(store.state.decisions.d1).toBeUndefined();
    store.hydrate({ decisions: {}, todos: {}, cursor: "01A" });
    run();
    expect(store.state.decisions.d1.id).toBe("d1");
  });

  it("animate=false is carried through to the flush entries", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const changes = [];
    store.subscribe((c) => changes.push(...c));
    store.apply(d("01B", "d1"), { animate: false });
    run();
    expect(changes[0].animate).toBe(false);
  });

  it("ghost lifecycle: upsert then remove of the same id in one burst", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const changes = [];
    store.subscribe((c) => changes.push(...c));
    // Upsert and remove d1 before flush
    store.apply(d("01B", "d1"));
    store.apply({ ulid: "01C", entity: "decision", op: "remove", data: { id: "d1" } });
    run();
    // Should coalesce to a single remove entry with prev: undefined
    expect(changes.length).toBe(1);
    expect(changes[0]).toMatchObject({ op: "remove", id: "d1", prev: undefined, next: undefined });
    expect(store.state.decisions.d1).toBeUndefined();
  });

  it("animate OR logic: same id twice in one burst uses final animate", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const changes = [];
    store.subscribe((c) => changes.push(...c));
    // Apply the same id twice with different animate values
    store.apply(d("01B", "d1", { summary: "v1" }), { animate: false });
    store.apply(d("01C", "d1", { summary: "v2" }), { animate: true });
    run();
    // Should coalesce to one upsert with animate: true (OR logic)
    expect(changes.length).toBe(1);
    expect(changes[0]).toMatchObject({ op: "upsert", id: "d1", animate: true });
    expect(store.state.decisions.d1.summary).toBe("v2");
  });
});
