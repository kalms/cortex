// src/viewer/store.js
/**
 * Normalized reactive store — the viewer's single client source of truth for
 * projected entities (decisions, todos). Replaces the refetched-blob model:
 * the legacy globals (DECISIONS/TODOS in viewer.js) become aliases of
 * `state.decisions` / `state.todos`, whose OBJECT IDENTITY never changes —
 * hydrate/apply mutate keys in place.
 *
 * Coalesced flush: N apply() calls inside one frame → ONE subscriber call
 * (scheduled via requestAnimationFrame by default; injectable for tests).
 * Cursor = the last applied delta's ULID; deltas at or below it are dropped
 * (safe reconnect overlap). See docs/architecture/viewer-sync-engine.md.
 */

export function createStore({ schedule } = {}) {
  const scheduleFlush = schedule || ((fn) => requestAnimationFrame(fn));
  const state = { decisions: {}, todos: {}, cursor: null };
  const subs = new Set();

  let hydrated = false;
  let queued = [];          // deltas applied before hydrate
  let pending = new Map();  // key `${entity}:${id}` → change entry (last wins, first prev kept)
  let flushScheduled = false;

  function bucket(entity) { return entity === "decision" ? state.decisions : state.todos; }

  function flush() {
    flushScheduled = false;
    if (pending.size === 0) return;
    const changes = [...pending.values()];
    pending = new Map();
    for (const fn of subs) fn(changes);
  }

  function requestFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    scheduleFlush(flush);
  }

  function record(entity, id, op, animate, prev, next) {
    const key = `${entity}:${id}`;
    const existing = pending.get(key);
    pending.set(key, {
      entity, id, op,
      animate: existing ? existing.animate || animate : animate,
      prev: existing ? existing.prev : prev, // first prev of the burst = true before-state
      next,
    });
    requestFlush();
  }
  // Burst coalescing contract: if an entity is upserted then removed within
  // one flush window (before run()), the final change entry will be
  // { op: 'remove', prev: undefined, next: undefined }. A consumer seeing
  // prev === undefined on a remove means nothing was ever rendered (the entity
  // appeared and vanished atomically), so teardown/animation can be skipped.

  function apply(delta, { animate = true } = {}) {
    if (!hydrated) { queued.push({ delta, animate }); return; }
    if (delta.ulid && state.cursor && delta.ulid <= state.cursor) return;
    const map = bucket(delta.entity);
    if (delta.op === "upsert") {
      const prev = map[delta.data.id];
      map[delta.data.id] = delta.data;
      record(delta.entity, delta.data.id, "upsert", animate, prev, delta.data);
    } else {
      const prev = map[delta.data.id];
      if (prev !== undefined) {
        delete map[delta.data.id];
        record(delta.entity, delta.data.id, "remove", animate, prev, undefined);
      }
      // remove of an absent id: no change entry, but the cursor still advances.
    }
    if (delta.ulid) state.cursor = delta.ulid;
  }

  function hydrate({ decisions = {}, todos = {}, cursor = null }) {
    for (const k of Object.keys(state.decisions)) delete state.decisions[k];
    Object.assign(state.decisions, decisions);
    for (const k of Object.keys(state.todos)) delete state.todos[k];
    Object.assign(state.todos, todos);
    state.cursor = cursor;
    hydrated = true;
    const q = queued; queued = [];
    for (const { delta, animate } of q) apply(delta, { animate });
  }

  return {
    state,
    get hydrated() { return hydrated; },
    hydrate,
    apply,
    setCursor(ulid) { state.cursor = ulid; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
