/**
 * Transition state for projection deltas: entering / exiting node animations.
 * Pure module; advanceTransitions mutates its own state only.
 *
 * Time units throughout are milliseconds; callers pass dt each frame.
 */

/**
 * Return an initial spawn position for a newly-entering node.
 * If the node carries a `.group` id that was visible in the previous
 * projection (i.e. the node is a child emerging from an unfolded supernode),
 * we seed it at the parent's last-known position plus a small random jitter
 * so that children don't all stack on the same pixel.
 * Falls back to (0, 0) when no parent context is available.
 * @param {{ group?: string }} node
 * @param {Map<string, { x?: number, y?: number }> | null} prevNodes
 * @returns {{ x: number, y: number }}
 */
function initialPositionForEntering(node, prevNodes) {
  if (node.group && prevNodes && prevNodes.has(node.group)) {
    const parent = prevNodes.get(node.group);
    return {
      x: (parent.x ?? 0) + (Math.random() - 0.5) * 20,
      y: (parent.y ?? 0) + (Math.random() - 0.5) * 20,
    };
  }
  // Cold-start fallback: scatter in a small ring so coincident nodes can
  // break symmetry under charge/collide. 200px radius keeps them on-canvas
  // for auto-fit to frame.
  const angle = Math.random() * Math.PI * 2;
  const r = 80 + Math.random() * 120;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

/**
 * Canonical key for an edge endpoint pair (order-independent).
 * @param {{ source_id: string, target_id: string }} e
 * @returns {string}
 */
function pairKey(e) {
  return `${e.source_id}↔${e.target_id}`;
}

/**
 * Detect edges whose `aggregate` boolean flipped between prev and curr for
 * the same endpoint pair (exact source_id/target_id match).
 * Returns an array of `{ from, to, age, duration }` cross-fade descriptors.
 * @param {{ visibleEdges: Map<string, object> }} prev
 * @param {{ visibleEdges: Map<string, object> }} curr
 * @returns {Array<{ from: object, to: object, age: number, duration: number }>}
 */
function diffEdges(prev, curr) {
  const reclassified = [];
  const prevByPair = new Map();
  for (const e of prev.visibleEdges.values()) {
    prevByPair.set(pairKey(e), e);
  }
  for (const e of curr.visibleEdges.values()) {
    const match = prevByPair.get(pairKey(e));
    if (match && !!match.aggregate !== !!e.aggregate) {
      reclassified.push({ from: match, to: e, age: 0, duration: 220 });
    }
  }
  return reclassified;
}

/**
 * Compute the set of node ids that entered and exited between two projections.
 * `null` previous treats all current ids as entering.
 *
 * Entering items are returned as `{ id, from: { x, y } }` objects so that
 * callers can seed entering animations at the correct position.  When a
 * node's parent supernode was visible in the previous projection (supernode
 * unfold / band-crossing), `from` is seeded at the parent's last-known
 * position rather than (0, 0), giving the "re-parenting on unfold" effect.
 *
 * Also returns `reclassified`: edges whose aggregate↔raw classification
 * flipped between projections (spec §7.2 — 220ms cross-fade).
 *
 * @returns {{ entering: Array<{ id: string, from: { x: number, y: number } }>, exiting: Set<string>, reclassified: Array<{ from: object, to: object, age: number, duration: number }> }}
 */
export function diffProjection(previous, current) {
  const entering = [];
  const exiting = new Set();
  const prevNodes = previous ? previous.visibleNodes : null;
  const prevIds = prevNodes ? new Set(prevNodes.keys()) : new Set();
  const currIds = new Set(current.visibleNodes.keys());
  for (const id of currIds) {
    if (!prevIds.has(id)) {
      const node = current.visibleNodes.get(id);
      entering.push({ id, from: initialPositionForEntering(node, prevNodes) });
    }
  }
  for (const id of prevIds) if (!currIds.has(id)) exiting.add(id);

  const reclassified = (previous && previous.visibleEdges && current.visibleEdges)
    ? diffEdges(previous, current)
    : [];

  return { entering, exiting, reclassified };
}

/** Create an empty transition state container. */
export function createTransitionState() {
  return { transitions: new Map() };
}

/**
 * Register an entering transition starting at spawnPos with opacity/scale 0→1.
 * Default duration 280ms.
 */
export function enterTransition(state, id, spawnPos, duration = 280) {
  state.transitions.set(id, {
    phase: 'entering',
    age: 0,
    duration,
    from: { x: spawnPos.x, y: spawnPos.y, opacity: 0, scale: 0 },
    to:   { x: spawnPos.x, y: spawnPos.y, opacity: 1, scale: 1 },
  });
}

/**
 * Register an exiting transition from currentRender toward exitPos with
 * opacity→0, scale→0.6. Default duration 220ms.
 */
export function exitTransition(state, id, currentRender, exitPos, duration = 220) {
  state.transitions.set(id, {
    phase: 'exiting',
    age: 0,
    duration,
    from: { ...currentRender },
    to:   { x: exitPos.x, y: exitPos.y, opacity: 0, scale: 0.6 },
  });
}

/**
 * Age every active transition by `dtMs` and remove those whose age >= duration.
 */
export function advanceTransitions(state, dtMs) {
  for (const [id, t] of state.transitions) {
    t.age += dtMs;
    if (t.age >= t.duration) state.transitions.delete(id);
  }
}

/**
 * Sample a transition's current interpolated value.
 * Entering uses ease-out-back on scale only (bloom overshoot), ease-out-cubic
 * on position + opacity (monotonic, stays in [0,1]). Exiting uses linear
 * position (matches spec §5), ease-in on opacity + scale.
 */
export function interpolated(t) {
  const u = Math.max(0, Math.min(1, t.age / t.duration));
  if (t.phase === 'entering') {
    // Entering: ease-out-cubic keeps opacity monotonic in [0,1]; scale gets
    // ease-out-back for a slight bloom overshoot.
    const easedScale = easeOutBack(u);
    const eased      = easeOutCubic(u);
    return {
      x:       lerp(t.from.x,       t.to.x,       eased),
      y:       lerp(t.from.y,       t.to.y,       eased),
      opacity: lerp(t.from.opacity, t.to.opacity, eased),
      scale:   lerp(t.from.scale,   t.to.scale,   easedScale),
    };
  }
  // Exiting — spec §5: "position linear lerps toward parent centroid";
  // opacity + scale use ease-in so the fade accelerates at the end.
  const eased = easeIn(u);
  return {
    x:       lerp(t.from.x,       t.to.x,       u),      // linear
    y:       lerp(t.from.y,       t.to.y,       u),      // linear
    opacity: lerp(t.from.opacity, t.to.opacity, eased),
    scale:   lerp(t.from.scale,   t.to.scale,   eased),
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function easeIn(u)     { return u * u; }
function easeOutCubic(u) {
  const x = 1 - u;
  return 1 - x * x * x;
}
function easeOutBack(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const c = 1.70158;
  const x = u - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}
