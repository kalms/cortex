import { createGraphState, hydrate } from '/viewer/shared/state.js';
import { SHAPE_FOR_KIND } from '/viewer/shared/shapes.js';
import { PALETTE_REST, rgbString, BACKGROUND } from '/viewer/shared/colors.js';
import { nodeSize } from '/viewer/shared/layout.js';

const canvas = document.getElementById('graph');
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
window.__cortex_viewer_state = state;  // hook for tests / debugging

const graph = await fetch('/api/graph').then(r => r.json());
hydrate(state, graph);

// Deterministic pseudo-random layout for static step 1 — replaced by d3-force next task.
let i = 0;
for (const node of state.nodes.values()) {
  const angle = (i * 137.5) * (Math.PI / 180);      // golden-angle spread
  const radius = 30 + Math.sqrt(i) * 30;
  node.x = Math.cos(angle) * radius;
  node.y = Math.sin(angle) * radius;
  i++;
}

function worldToScreen(x, y) {
  return [x + canvas.clientWidth / 2, y + canvas.clientHeight / 2];
}

function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  // Edges: 0.5px white lines at low alpha.
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (const edge of state.edges.values()) {
    const a = state.nodes.get(edge.source_id);
    const b = state.nodes.get(edge.target_id);
    if (!a || !b) continue;
    const [ax, ay] = worldToScreen(a.x, a.y);
    const [bx, by] = worldToScreen(b.x, b.y);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // Nodes: filled shape per kind.
  for (const node of state.nodes.values()) {
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const color = PALETTE_REST[node.kind] || PALETTE_REST.file;
    const [sx, sy] = worldToScreen(node.x, node.y);
    shape(ctx, sx, sy, nodeSize(node.kind), rgbString(color, 1));
  }
}

draw();
