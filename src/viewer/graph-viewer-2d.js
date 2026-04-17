import { createGraphState, hydrate, edgeKey, applyMutation } from '/viewer/shared/state.js';
import { createWsClient } from '/viewer/shared/websocket.js';
import { SHAPE_FOR_KIND, drawStrike } from '/viewer/shared/shapes.js';
import {
  PALETTE_REST,
  PALETTE_HOVER,
  EDGE_ALPHA,
  lerpRGB,
  rgbString,
  BACKGROUND,
} from '/viewer/shared/colors.js';
import { nodeSize, createSimulation } from '/viewer/shared/layout.js';
import {
  createAnimState,
  advance,
  setHover,
  setEdgeHover,
  clearHover,
} from '/viewer/shared/animation.js';

const canvas = document.getElementById('graph');
const tooltip = document.getElementById('tooltip');
const ctx = canvas.getContext('2d');
const DPR = window.devicePixelRatio || 1;

function resize() {
  canvas.width = canvas.clientWidth * DPR;
  canvas.height = canvas.clientHeight * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const state = createGraphState();
const anim = createAnimState();
window.__cortex_viewer_state = state;
window.__cortex_viewer_anim = anim;

const graph = await fetch('/api/graph').then(r => r.json());
hydrate(state, graph);

const simulation = createSimulation()
  .nodes([...state.nodes.values()])
  .on('tick', () => {});
simulation.force('link').links([...state.edges.values()].map(e => ({
  source: e.source_id,
  target: e.target_id,
  relation: e.relation,
})));

// --- Neighbor index --- rebuild whenever edges change.
let neighborsOf = new Map();
function rebuildNeighbors() {
  neighborsOf = new Map();
  for (const edge of state.edges.values()) {
    if (!neighborsOf.has(edge.source_id)) neighborsOf.set(edge.source_id, new Set());
    if (!neighborsOf.has(edge.target_id)) neighborsOf.set(edge.target_id, new Set());
    neighborsOf.get(edge.source_id).add(edge.target_id);
    neighborsOf.get(edge.target_id).add(edge.source_id);
  }
}
rebuildNeighbors();

// --- WebSocket live updates ---
function syncSimulation() {
  simulation.nodes([...state.nodes.values()]);
  simulation.force('link').links([...state.edges.values()].map(e => ({
    source: e.source_id,
    target: e.target_id,
    relation: e.relation,
  })));
  simulation.alpha(0.3).restart();  // gentle reheat, not 1.0
}

createWsClient({
  url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
  onHello: (msg) => console.log('cortex ws hello', msg.project_id, msg.server_version),
  onEvent: () => { /* stream component (Plan C) consumes these */ },
  onMutation: (m) => {
    applyMutation(state, m);
    rebuildNeighbors();
    syncSimulation();
  },
  onBackfill: () => { /* events only (server sends mutations:[]) — for stream */ },
});

// --- Hover detection ---
let hoveredId = null;
canvas.addEventListener('pointermove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left - rect.width / 2;
  const my = ev.clientY - rect.top  - rect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const node of state.nodes.values()) {
    const dx = (node.x ?? 0) - mx;
    const dy = (node.y ?? 0) - my;
    const d = dx * dx + dy * dy;
    const r = nodeSize(node.kind) + 3;
    if (d < r * r && d < bestDist) { best = node; bestDist = d; }
  }
  if (best && best.id !== hoveredId) {
    hoveredId = best.id;
    const ns = neighborsOf.get(best.id) || new Set();
    setHover(anim, best.id, ns);
    const keys = new Set();
    for (const edge of state.edges.values()) {
      if (edge.source_id === best.id || edge.target_id === best.id) {
        keys.add(edgeKey(edge));
      }
    }
    setEdgeHover(anim, keys);
    tooltip.textContent = best.name;
    tooltip.classList.add('show');
  } else if (!best && hoveredId) {
    hoveredId = null;
    clearHover(anim);
    tooltip.classList.remove('show');
  }
  tooltip.style.left = (ev.clientX + 14) + 'px';
  tooltip.style.top  = (ev.clientY + 14) + 'px';
});

canvas.addEventListener('pointerleave', () => {
  hoveredId = null;
  clearHover(anim);
  tooltip.classList.remove('show');
});

// --- Render ---
function worldToScreen(x, y) {
  return [x + canvas.clientWidth / 2, y + canvas.clientHeight / 2];
}

function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.lineWidth = 0.5;
  for (const edge of state.edges.values()) {
    const a = state.nodes.get(edge.source_id);
    const b = state.nodes.get(edge.target_id);
    if (!a || !b) continue;
    const eKey = edgeKey(edge);
    const alphaSpec = EDGE_ALPHA[edge.relation] || EDGE_ALPHA.CALLS;
    const eAnim = anim.edges.get(eKey);
    const h = eAnim ? eAnim.highlight : 0;
    const alpha = alphaSpec.rest + (alphaSpec.hover - alphaSpec.rest) * h;
    ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
    const [ax, ay] = worldToScreen(a.x ?? 0, a.y ?? 0);
    const [bx, by] = worldToScreen(b.x ?? 0, b.y ?? 0);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  for (const node of state.nodes.values()) {
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const base = PALETTE_REST[node.kind] || PALETTE_REST.file;
    const hover = PALETTE_HOVER[node.kind] || PALETTE_HOVER.file;
    const nAnim = anim.nodes.get(node.id) || { highlight: 0, colorMix: 0 };

    const rgb = lerpRGB(base, hover, nAnim.colorMix);

    // Status: 'proposed' / 'superseded' → 40% base opacity.
    const statusAlpha = node.status === 'proposed' || node.status === 'superseded' ? 0.4 : 1.0;
    // Hover dims non-highlighted to 50% of base, highlighted nodes to base+0.25.
    const restAlpha  = statusAlpha * 0.5;
    const hoverAlpha = Math.min(1, statusAlpha + 0.25);
    // If nothing is hovered (noone highlighted), use statusAlpha directly.
    const alpha = hoveredId === null
      ? statusAlpha
      : restAlpha + (hoverAlpha - restAlpha) * nAnim.highlight;

    const r = nodeSize(node.kind) * (1 + nAnim.highlight * 0.15);
    const [sx, sy] = worldToScreen(node.x ?? 0, node.y ?? 0);
    shape(ctx, sx, sy, r, rgbString(rgb, alpha));
    if (node.status === 'superseded') {
      drawStrike(ctx, sx, sy, r, 'rgba(255,255,255,' + (alpha * 0.8) + ')');
    }
  }
}

function applyBreathing(t) {
  for (const node of state.nodes.values()) {
    node.vx = (node.vx || 0) * 0.92 + Math.sin(t * 0.008 + (node.x || 0) * 0.01) * 0.0015;
    node.vy = (node.vy || 0) * 0.92 + Math.cos(t * 0.006 + (node.y || 0) * 0.01) * 0.0015;
  }
}

function frame(t) {
  simulation.tick();
  applyBreathing(t);
  advance(anim, 1);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
