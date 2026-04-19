/**
 * Transition state for projection deltas: entering / exiting node animations.
 * Pure module; advanceTransitions mutates its own state only.
 *
 * Time units throughout are milliseconds; callers pass dt each frame.
 */

/**
 * Compute the set of node ids that entered and exited between two projections.
 * `null` previous treats all current ids as entering.
 * @returns {{ entering: Set<string>, exiting: Set<string> }}
 */
export function diffProjection(previous, current) {
  const entering = new Set();
  const exiting = new Set();
  const prevIds = previous ? new Set(previous.visibleNodes.keys()) : new Set();
  const currIds = new Set(current.visibleNodes.keys());
  for (const id of currIds) if (!prevIds.has(id)) entering.add(id);
  for (const id of prevIds) if (!currIds.has(id)) exiting.add(id);
  return { entering, exiting };
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
