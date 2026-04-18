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
  triggerSynapse,
} from '/viewer/shared/animation.js';
import { searchMatch } from '/viewer/shared/search.js';
import {
  createCamera,
  worldToScreen as camWorldToScreen,
  screenToWorld as camScreenToWorld,
  fitToBounds,
  zoomAtPoint,
  lerpCamera,
} from '/viewer/shared/camera.js';

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

let camera = createCamera();
let targetCamera = null;   // when set, frame() lerps camera toward it
let hasInitiallyFit = false;
window.__cortex_viewer_camera = () => camera;  // hook for tests / debugging

function recenter() {
  targetCamera = fitToBounds(
    state.nodes.values(),
    canvas.clientWidth,
    canvas.clientHeight,
    40,
  );
}

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
  onEvent: (e) => {
    if (e.kind === 'decision.superseded') {
      // 3s sequence: pulse each GOVERNS edge of old (staggered), then flip to strike,
      // then draw SUPERSEDES edge, then new node ring ripple, then new GOVERNS pulses.
      const oldId = e.payload.old_id;
      const newId = e.payload.new_id;

      // Pulse governing edges of old, staggered.
      const oldGoverns = [...state.edges.values()].filter(
        (edge) => edge.source_id === oldId && edge.relation === 'GOVERNS',
      );
      oldGoverns.forEach((edge, i) => {
        setTimeout(() => {
          triggerSynapse(anim, {
            kind: 'pulse',
            source: edge.source_id,
            target: edge.target_id,
            duration: 30,
          });
        }, i * 80);
      });

      // After pulses, the actual `update_node` mutation will flip old.status = 'superseded'
      // (emitted by the backend) — no extra work here.

      // Ring the new node 1.2s in.
      setTimeout(() => {
        if (state.nodes.has(newId)) {
          triggerSynapse(anim, { kind: 'ring', nodeId: newId, duration: 60 });
        }
      }, 1200);
    }
  },
  onMutation: (m) => {
    applyMutation(state, m);
    rebuildNeighbors();
    syncSimulation();
    switch (m.op) {
      case 'add_node':
        triggerSynapse(anim, { kind: 'ring', nodeId: m.node.id, duration: 60 });
        break;
      case 'add_edge':
        triggerSynapse(anim, {
          kind: 'pulse',
          edgeKey: edgeKey(m.edge),
          source: m.edge.source_id,
          target: m.edge.target_id,
          duration: 45,
        });
        break;
      // 'remove_node' is instant in v1. A true fade would require deferring
      // state.nodes.delete() until the synapse expires — acceptable follow-up.
    }
  },
  onBackfill: () => { /* events only (server sends mutations:[]) — for stream */ },
  // KNOWN LIMITATION: if the WS disconnects and mutations are emitted during
  // the outage, they are not replayed on reconnect. Backfill carries events
  // only (for the stream); the graph can silently drift from server state.
  // Fix when >500-mutation drift recovery lands (spec: "client discards
  // local state and calls GET /api/graph again").
});

// --- Hit-test: find the node under a pointer event, or null. ---
// Single-source the nearest-node search used by hover, click, and dblclick.
// Radius bias `+3` gives a small forgiving margin around each node's shape.
function pickNodeAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const [wx, wy] = camScreenToWorld(
    camera,
    ev.clientX - rect.left,
    ev.clientY - rect.top,
    rect.width,
    rect.height,
  );
  let best = null;
  let bestDist = Infinity;
  for (const node of state.nodes.values()) {
    const dx = (node.x ?? 0) - wx;
    const dy = (node.y ?? 0) - wy;
    const d = dx * dx + dy * dy;
    const r = (nodeSize(node.kind) + 3) / camera.zoom;
    if (d < r * r && d < bestDist) { best = node; bestDist = d; }
  }
  return best;
}

// --- Hover detection ---
let hoveredId = null;

// --- Pan state ---
let isPanning = false;
let panStart = null;  // { screenX, screenY, cameraX, cameraY }
let didPan = false;   // suppress click after a drag

canvas.addEventListener('pointerdown', (ev) => {
  // Only pan if no node is under the cursor (otherwise let click/dblclick through).
  if (pickNodeAt(ev)) return;
  isPanning = true;
  panStart = { screenX: ev.clientX, screenY: ev.clientY, cameraX: camera.x, cameraY: camera.y };
  canvas.classList.add('panning');
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener('pointermove', (ev) => {
  if (isPanning && panStart) {
    const dx = (ev.clientX - panStart.screenX) / camera.zoom;
    const dy = (ev.clientY - panStart.screenY) / camera.zoom;
    camera = { ...camera, x: panStart.cameraX - dx, y: panStart.cameraY - dy };
    targetCamera = null;  // cancel any in-progress lerp — user is driving now
    didPan = true;
    return;
  }
  const best = pickNodeAt(ev);
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

function endPan(ev) {
  if (!isPanning) return;
  isPanning = false;
  panStart = null;
  canvas.classList.remove('panning');
  if (ev && ev.pointerId !== undefined) {
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
  }
  // Keep didPan set through the immediately-following click, then clear.
  setTimeout(() => { didPan = false; }, 0);
}

canvas.addEventListener('pointerup', endPan);
canvas.addEventListener('pointercancel', endPan);

canvas.addEventListener('wheel', (ev) => {
  if (ev.deltaY === 0) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const factor = Math.exp(-ev.deltaY * 0.001);
  camera = zoomAtPoint(camera, factor, sx, sy, rect.width, rect.height);
  targetCamera = null;  // user-driven zoom cancels any in-progress animation
}, { passive: false });

canvas.addEventListener('pointerleave', (ev) => {
  endPan(ev);
  hoveredId = null;
  clearHover(anim);
  tooltip.classList.remove('show');
});

// --- Search + filter ---
let searchQuery = '';
const activeKinds = new Set(['decision', 'file', 'function', 'component', 'reference', 'path']);

const searchInput = document.getElementById('search');
const searchCount = document.getElementById('search-count');

function updateSearchCount() {
  if (!searchQuery) {
    searchCount.classList.add('hidden');
    searchCount.textContent = '';
    return;
  }
  let matches = 0;
  let total = 0;
  for (const node of state.nodes.values()) {
    if (!isVisible(node)) continue;
    total++;
    if (searchMatch(node, searchQuery)) matches++;
  }
  searchCount.textContent = matches + ' / ' + total;
  searchCount.classList.remove('hidden');
}

searchInput.addEventListener('input', (ev) => {
  searchQuery = ev.target.value.toLowerCase();
  updateSearchCount();
});

searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = '';
    searchQuery = '';
    updateSearchCount();
    searchInput.blur();
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && document.activeElement !== searchInput) {
    ev.preventDefault();
    searchInput.focus();
  }
});

document.querySelectorAll('#filters input').forEach((cb) => {
  cb.addEventListener('change', () => {
    const k = cb.dataset.kind;
    if (cb.checked) activeKinds.add(k); else activeKinds.delete(k);
    updateSearchCount();
  });
});

function isVisible(node) {
  if (focusSet && !focusSet.has(node.id)) return false;
  if (!activeKinds.has(node.kind)) return false;
  return true;
}

// --- Render ---
function worldToScreen(wx, wy) {
  return camWorldToScreen(camera, wx, wy, canvas.clientWidth, canvas.clientHeight);
}

function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.save();
  ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  ctx.lineWidth = 0.5 / camera.zoom;   // keep edges crisp at any zoom
  for (const edge of state.edges.values()) {
    const a = state.nodes.get(edge.source_id);
    const b = state.nodes.get(edge.target_id);
    if (!a || !b) continue;
    if (!isVisible(a) || !isVisible(b)) continue;
    const eKey = edgeKey(edge);
    const alphaSpec = EDGE_ALPHA[edge.relation] || EDGE_ALPHA.CALLS;
    const eAnim = anim.edges.get(eKey);
    const h = eAnim ? eAnim.highlight : 0;
    const alpha = alphaSpec.rest + (alphaSpec.hover - alphaSpec.rest) * h;
    const edgeBright = !searchQuery || (searchMatch(a, searchQuery) && searchMatch(b, searchQuery));
    const edgeSearchDim = edgeBright ? 1.0 : 0.15;
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * edgeSearchDim) + ')';
    ctx.beginPath();
    ctx.moveTo(a.x ?? 0, a.y ?? 0);
    ctx.lineTo(b.x ?? 0, b.y ?? 0);
    ctx.stroke();
  }

  for (const node of state.nodes.values()) {
    if (!isVisible(node)) continue;
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const base = PALETTE_REST[node.kind] || PALETTE_REST.file;
    const hover = PALETTE_HOVER[node.kind] || PALETTE_HOVER.file;
    const nAnim = anim.nodes.get(node.id) || { highlight: 0, colorMix: 0 };
    const rgb = lerpRGB(base, hover, nAnim.colorMix);
    const statusAlpha = node.status === 'proposed' || node.status === 'superseded' ? 0.4 : 1.0;
    const restAlpha  = statusAlpha * 0.5;
    const hoverAlpha = Math.min(1, statusAlpha + 0.25);
    const alpha = hoveredId === null
      ? statusAlpha
      : restAlpha + (hoverAlpha - restAlpha) * nAnim.highlight;
    const matches = searchMatch(node, searchQuery);
    const searchDim = searchQuery && !matches ? 0.15 : 1.0;
    const r = nodeSize(node.kind) * (1 + nAnim.highlight * 0.15);
    shape(ctx, node.x ?? 0, node.y ?? 0, r, rgbString(rgb, alpha * searchDim));
    if (node.status === 'superseded') {
      drawStrike(ctx, node.x ?? 0, node.y ?? 0, r, 'rgba(255,255,255,' + (alpha * searchDim * 0.8) + ')');
    }
  }

  drawSynapses();

  ctx.restore();

  drawLabels();
}

function drawLabels() {
  ctx.save();
  ctx.font = '11px "Geist Mono", monospace';
  ctx.textBaseline = 'middle';

  for (const node of state.nodes.values()) {
    if (!isVisible(node)) continue;

    // Per-kind fade windows.
    let alpha = 0;
    if (node.kind === 'decision') {
      alpha = 1;
    } else if (node.kind === 'file') {
      // 0.4 → 0.6 linear
      const t = (camera.zoom - 0.4) / 0.2;
      alpha = t <= 0 ? 0 : t >= 1 ? 1 : t;
    } else {
      // functions, components, references, paths: 0.9 → 1.1 linear
      const t = (camera.zoom - 0.9) / 0.2;
      alpha = t <= 0 ? 0 : t >= 1 ? 1 : t;
    }

    if (alpha <= 0) continue;

    // Search dim also applies to labels.
    if (searchQuery && !searchMatch(node, searchQuery)) alpha *= 0.15;

    const [sx, sy] = camWorldToScreen(
      camera,
      node.x ?? 0,
      node.y ?? 0,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    // Offset label to the right of the node (size scales with on-screen apparent size).
    const offset = nodeSize(node.kind) * camera.zoom + 4;
    ctx.fillStyle = 'rgba(153,153,153,' + alpha + ')';   // #999
    ctx.fillText(String(node.name || ''), sx + offset, sy + 3);
  }

  ctx.restore();
}

function drawSynapses() {
  for (const s of anim.synapses) {
    const progress = s.age / s.duration;
    if (s.kind === 'ring') {
      const node = state.nodes.get(s.nodeId);
      if (!node) continue;
      const r = nodeSize(node.kind) + progress * 22;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(180,160,224,' + (1 - progress) + ')';
      ctx.lineWidth = 1 / camera.zoom;
      ctx.stroke();
    } else if (s.kind === 'pulse') {
      const a = state.nodes.get(s.source);
      const b = state.nodes.get(s.target);
      if (!a || !b) continue;
      const px = (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * progress;
      const py = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * progress;
      ctx.beginPath();
      ctx.arc(px, py, 2.5 / camera.zoom, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (1 - progress) + ')';
      ctx.fill();
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

  if (!hasInitiallyFit && simulation.alpha() < 0.3) {
    // Wait for the sim to actually reach roughly equilibrium before framing.
    // With the Task 1 force tuning, alpha < 0.3 fires at ~tick 50 (≈0.8s at 60fps).
    const fit = fitToBounds(state.nodes.values(), canvas.clientWidth, canvas.clientHeight, 40);
    camera = fit;
    hasInitiallyFit = true;
  }

  // Smooth camera animation toward a target, if one is set.
  if (targetCamera) {
    camera = lerpCamera(camera, targetCamera, 0.15);
    const dx = targetCamera.x - camera.x;
    const dy = targetCamera.y - camera.y;
    const dz = targetCamera.zoom - camera.zoom;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.005) {
      camera = targetCamera;
      targetCamera = null;
    }
  }

  applyBreathing(t);
  advance(anim, 1);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Detail panel ---
const detailPanel = document.getElementById('detail-panel');
const detailContent = document.getElementById('detail-content');
const closePanel = document.getElementById('close-panel');
let selectedId = null;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function field(label, value) {
  return '<div class="field"><div class="field-label">' + escapeHtml(label) +
    '</div><div class="field-value">' + value + '</div></div>';
}

function showDetail(node) {
  selectedId = node.id;
  const data = typeof node.data === 'string' ? JSON.parse(node.data) : (node.data || {});
  let html = '<h2>' + escapeHtml(node.name) + '</h2>';
  html += field('Kind', escapeHtml(node.kind));
  if (node.tier)           html += field('Tier', escapeHtml(node.tier));
  if (node.status)         html += field('Status', escapeHtml(node.status));
  if (node.qualified_name) html += field('Qualified name', escapeHtml(node.qualified_name));
  if (node.file_path)      html += field('File', escapeHtml(node.file_path));
  if (data.rationale)      html += field('Rationale', escapeHtml(data.rationale));
  if (data.description)    html += field('Description', escapeHtml(data.description));

  const connected = [...state.edges.values()]
    .filter(e => e.source_id === node.id || e.target_id === node.id)
    .map(e => {
      const otherId = e.source_id === node.id ? e.target_id : e.source_id;
      const dir = e.source_id === node.id ? '→' : '←';
      const other = state.nodes.get(otherId);
      const name = other ? other.name : otherId;
      return '<a href="#" class="connection-link" data-node-id="' + escapeHtml(otherId) +
        '">' + escapeHtml(dir + ' ' + e.relation + ' ' + name) + '</a>';
    });
  if (connected.length) html += field('Connections', connected.join('<br>'));

  html += field('ID', escapeHtml(node.id));
  detailContent.innerHTML = html;
  detailPanel.classList.remove('hidden');

  detailContent.querySelectorAll('.connection-link').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      const target = state.nodes.get(link.dataset.nodeId);
      if (target) showDetail(target);
    });
  });
}

function closeDetail() {
  selectedId = null;
  detailPanel.classList.add('hidden');
}

closePanel.addEventListener('click', closeDetail);

canvas.addEventListener('click', (ev) => {
  if (didPan) return;
  const best = pickNodeAt(ev);
  if (best) showDetail(best);
  else closeDetail();
});

// --- Focus mode ---
// Double-click a node → restrict visible graph to its 1-hop neighborhood + edges.
// Esc → clear focus.
let focusId = null;

function bfsNeighborhood(rootId, depth) {
  const seen = new Set([rootId]);
  let frontier = [rootId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) {
      const neighbors = neighborsOf.get(id) || new Set();
      for (const n of neighbors) {
        if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    frontier = next;
  }
  return seen;
}

let focusSet = null; // Set<id> of visible nodes when in focus mode.

canvas.addEventListener('dblclick', (ev) => {
  const best = pickNodeAt(ev);
  if (best) {
    focusId = best.id;
    focusSet = bfsNeighborhood(best.id, 1);
    // Animate camera to fit the focused subgraph.
    const focusedNodes = [...state.nodes.values()].filter((n) => focusSet.has(n.id));
    targetCamera = fitToBounds(
      focusedNodes,
      canvas.clientWidth,
      canvas.clientHeight,
      80,
    );
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    focusId = null;
    focusSet = null;
    targetCamera = fitToBounds(
      state.nodes.values(),
      canvas.clientWidth,
      canvas.clientHeight,
      40,
    );
  }
});

document.getElementById('recenter-btn').addEventListener('click', recenter);

window.addEventListener('keydown', (ev) => {
  if (document.activeElement === searchInput) return;
  if (ev.key === 'f' || ev.key === 'F' || ev.key === 'r' || ev.key === 'R') {
    ev.preventDefault();
    recenter();
  }
});
