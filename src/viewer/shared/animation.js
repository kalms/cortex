/**
 * Hover + synapse animation state machine for the 2D viewer.
 *
 * Per-node state:    { highlight, colorMix, targetHighlight, targetColorMix }
 * Per-edge state:    { highlight, targetHighlight }
 * Synapses:          [{ kind, nodeId?, edgeKey?, age, duration, ...data }]
 *
 * `advance(state, dtFrames)` is called every render frame. It lerps current
 * values toward targets and ages synapses; expired synapses are pruned.
 * Rendering reads highlight / colorMix / age-based values directly.
 */

export const LERP_FACTOR = 0.12; // per frame; ~7 frames to 50%, ~20 to 95%.

export function createAnimState() {
  return {
    nodes: new Map(),
    edges: new Map(),
    synapses: [],
  };
}

function getOrInitNode(state, id) {
  let n = state.nodes.get(id);
  if (!n) {
    n = { highlight: 0, colorMix: 0, targetHighlight: 0, targetColorMix: 0 };
    state.nodes.set(id, n);
  }
  return n;
}

function getOrInitEdge(state, key) {
  let e = state.edges.get(key);
  if (!e) {
    e = { highlight: 0, targetHighlight: 0 };
    state.edges.set(key, e);
  }
  return e;
}

/**
 * On hover: hovered node full intensity, neighbors partial, everything else
 * relaxed. Call from pointermove.
 */
export function setHover(state, hoveredId, neighborIds) {
  // First, reset every existing entry to 0.
  for (const n of state.nodes.values()) {
    n.targetHighlight = 0;
    n.targetColorMix = 0;
  }
  const h = getOrInitNode(state, hoveredId);
  h.targetHighlight = 1;
  h.targetColorMix = 1;
  for (const id of neighborIds) {
    const n = getOrInitNode(state, id);
    n.targetHighlight = 0.6;
    n.targetColorMix = 1;
  }
}

export function setEdgeHover(state, edgeKeys) {
  for (const e of state.edges.values()) e.targetHighlight = 0;
  for (const k of edgeKeys) {
    const e = getOrInitEdge(state, k);
    e.targetHighlight = 1;
  }
}

export function clearHover(state) {
  for (const n of state.nodes.values()) {
    n.targetHighlight = 0;
    n.targetColorMix = 0;
  }
  for (const e of state.edges.values()) {
    e.targetHighlight = 0;
  }
}

/**
 * Trigger a synapse. kind ∈ 'ring' | 'pulse' | 'fade' | 'strike'.
 * `duration` in frames. Extra fields (e.g., edgeKey for pulse) are preserved.
 */
export function triggerSynapse(state, synapse) {
  state.synapses.push({ ...synapse, age: 0 });
}

/**
 * Lerp highlight/colorMix toward target, advance synapse ages, prune expired.
 * `dtFrames` is always 1 in practice (frame-paced); the parameter exists for
 * dt-independent pacing if we later switch to variable-step.
 */
export function advance(state, dtFrames) {
  const f = LERP_FACTOR * dtFrames;
  for (const n of state.nodes.values()) {
    n.highlight += (n.targetHighlight - n.highlight) * f;
    n.colorMix  += (n.targetColorMix  - n.colorMix)  * f;
  }
  for (const e of state.edges.values()) {
    e.highlight += (e.targetHighlight - e.highlight) * f;
  }
  for (const s of state.synapses) s.age += dtFrames;
  // Prune.
  let w = 0;
  for (let r = 0; r < state.synapses.length; r++) {
    const s = state.synapses[r];
    if (s.age < s.duration) state.synapses[w++] = s;
  }
  state.synapses.length = w;
}
