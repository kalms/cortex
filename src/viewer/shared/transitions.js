/**
 * Transition state for projection deltas: entering / exiting node animations.
 * Pure module; advanceTransitions mutates its own state only.
 *
 * Time units throughout are milliseconds; callers pass dt each frame.
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

export function createTransitionState() {
  return { transitions: new Map() };
}

export function enterTransition(state, id, spawnPos, duration = 280) {
  state.transitions.set(id, {
    phase: 'entering',
    age: 0,
    duration,
    from: { x: spawnPos.x, y: spawnPos.y, opacity: 0, scale: 0 },
    to:   { x: spawnPos.x, y: spawnPos.y, opacity: 1, scale: 1 },
  });
}

export function exitTransition(state, id, currentRender, exitPos, duration = 220) {
  state.transitions.set(id, {
    phase: 'exiting',
    age: 0,
    duration,
    from: { ...currentRender },
    to:   { x: exitPos.x, y: exitPos.y, opacity: 0, scale: 0.6 },
  });
}

export function advanceTransitions(state, dtMs) {
  for (const [id, t] of state.transitions) {
    t.age += dtMs;
    if (t.age >= t.duration) state.transitions.delete(id);
  }
}

export function interpolated(t) {
  const u = Math.max(0, Math.min(1, t.age / t.duration));
  // Position and opacity use a monotonic ease so opacity stays in [0, 1].
  // Scale uses ease-out-back for a slight bloom overshoot on entering.
  const easeMain = t.phase === 'entering' ? easeOutCubic(u) : easeIn(u);
  const easeScale = t.phase === 'entering' ? easeOutBack(u) : easeIn(u);
  return {
    x:       lerp(t.from.x,       t.to.x,       easeMain),
    y:       lerp(t.from.y,       t.to.y,       easeMain),
    opacity: lerp(t.from.opacity, t.to.opacity, easeMain),
    scale:   lerp(t.from.scale,   t.to.scale,   easeScale),
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
