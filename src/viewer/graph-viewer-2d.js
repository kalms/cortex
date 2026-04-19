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
import { project, projectionDeltaIsInteresting, BAND_TABLE } from '/viewer/shared/projection.js';
import { sizeAt, edgeStrokeAt } from '/viewer/shared/sizing.js';

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

// --- Projection state (must be hoisted above sim setup; inputs are read by reproject). ---
let projected = null;   // current projection output
let lastProjectionInputs = null;

// Hoisted inputs to projectionInputs(): these are also mutated by the search/filter
// handlers and focus mode lower in the file. Originals were declared later; moved
// up so reproject() can see them.
const activeKinds = new Set(['decision', 'file', 'function', 'component', 'reference', 'path']);
let searchQuery = '';
let focusId = null;
let focusSet = null;

function projectionInputs() {
  return {
    zoom: camera.zoom,
    focus: focusSet ? { root: focusId, depth: 1 } : null,
    filters: activeKinds,
    search: searchQuery,
  };
}

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

const simulation = createSimulation().on('tick', () => {});

function reproject(reason) {
  const inputs = projectionInputs();
  const next = project(state, inputs);
  applyEntryPositions(next, projected);
  const changed = projectionDeltaIsInteresting(projected, next);
  projected = next;
  lastProjectionInputs = inputs;
  if (changed) {
    simulation.nodes([...projected.visibleNodes.values()]);
    simulation.force('link').links([...projected.visibleEdges.values()].map((e) => ({
      source: e.source_id,
      target: e.target_id,
      relation: e.relation,
      aggregate: !!e.aggregate,
      count: e.count,
    })));
    simulation.alpha(alphaFor(reason)).restart();
  }
}

function alphaFor(reason) {
  switch (reason) {
    case 'focus-enter':
    case 'focus-exit': return 0.5;
    case 'band-cross': return 0.4;
    case 'mutation':
    case 'filter':    return 0.3;
    case 'search':    return 0.2;
    default:          return 0.3;
  }
}

function applyEntryPositions(next, prev) {
  const prevVisible = prev ? prev.visibleNodes : new Map();
  for (const [id, n] of next.visibleNodes) {
    if (prevVisible.has(id)) {
      const old = prevVisible.get(id);
      if (old.x !== undefined) { n.x = old.x; n.y = old.y; n.vx = old.vx; n.vy = old.vy; }
      continue;
    }
    if (n.kind === 'group' && n.members && n.members.length) {
      let sx = 0, sy = 0, count = 0;
      for (const m of n.members) {
        const old = prevVisible.get(m);
        if (old && old.x !== undefined) { sx += old.x; sy += old.y; count++; }
      }
      if (count) { n.x = sx / count + jitter(); n.y = sy / count + jitter(); }
    } else {
      const stateNode = state.nodes.get(id);
      if (stateNode && stateNode.file_path) {
        const parentDirId = `group:path:${dirnameOf(stateNode.file_path)}`;
        const parent = prevVisible.get(parentDirId);
        if (parent && parent.x !== undefined) {
          n.x = parent.x + jitter(); n.y = parent.y + jitter();
        }
      }
    }
  }
}

function jitter() { return (Math.random() - 0.5) * 8; }
function dirnameOf(p) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}
function bandIndexFor(zoom) {
  for (let i = 0; i < BAND_TABLE.length; i++) {
    if (zoom < BAND_TABLE[i].maxZoom) return i;
  }
  return BAND_TABLE.length - 1;
}

reproject('mutation');

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
    reproject('mutation');
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
  for (const node of (projected?.visibleNodes.values() ?? state.nodes.values())) {
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
  const prevBand = bandIndexFor(camera.zoom);
  camera = zoomAtPoint(camera, factor, sx, sy, rect.width, rect.height);
  targetCamera = null;  // user-driven zoom cancels any in-progress animation
  const nextBand = bandIndexFor(camera.zoom);
  if (prevBand !== nextBand) reproject('band-cross');
}, { passive: false });

canvas.addEventListener('pointerleave', (ev) => {
  endPan(ev);
  hoveredId = null;
  clearHover(anim);
  tooltip.classList.remove('show');
});

// --- Search + filter ---
// searchQuery, activeKinds are declared near the top of the file (hoisted for reproject).

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
  for (const node of (projected?.visibleNodes.values() ?? state.nodes.values())) {
    total++;
    if (searchMatch(node, searchQuery)) matches++;
  }
  searchCount.textContent = matches + ' / ' + total;
  searchCount.classList.remove('hidden');
}

let searchDebounce = null;
searchInput.addEventListener('input', (ev) => {
  searchQuery = ev.target.value.toLowerCase();
  updateSearchCount();
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { reproject('search'); }, 200);
});

searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = '';
    searchQuery = '';
    updateSearchCount();
    searchInput.blur();
    if (searchDebounce) clearTimeout(searchDebounce);
    reproject('search');
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
    reproject('filter');
  });
});

// --- Render ---
function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.save();
  ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  // Edge endpoints may be group representatives (not in state.nodes); resolve
  // from the projection first, fall back to raw state for the initial frame.
  const visibleNodeLookup = projected?.visibleNodes;
  const lookupNode = (id) =>
    (visibleNodeLookup && visibleNodeLookup.get(id)) || state.nodes.get(id);

  ctx.lineWidth = 0.5 / camera.zoom;   // keep edges crisp at any zoom
  for (const edge of (projected?.visibleEdges.values() ?? state.edges.values())) {
    const a = lookupNode(edge.source_id);
    const b = lookupNode(edge.target_id);
    if (!a || !b) continue;
    const eKey = edgeKey(edge);
    const alphaSpec = EDGE_ALPHA[edge.relation] || EDGE_ALPHA.CALLS;
    const eAnim = anim.edges.get(eKey);
    const h = eAnim ? eAnim.highlight : 0;
    const isSelectedEdge =
      selectedId !== null && (edge.source_id === selectedId || edge.target_id === selectedId);
    const selectionBoost = isSelectedEdge ? 1.0 : 0;
    const effectiveHighlight = Math.max(h, selectionBoost);
    const alpha = alphaSpec.rest + (alphaSpec.hover - alphaSpec.rest) * effectiveHighlight;
    // Hover wins locally: an edge attached to the hovered node stays bright
    // even when search is active and the other endpoint doesn't match.
    const edgeBright = !searchQuery
      || (searchMatch(a, searchQuery) && searchMatch(b, searchQuery))
      || a.id === hoveredId || b.id === hoveredId
      || isSelectedEdge;
    const edgeSearchDim = edgeBright ? 1.0 : 0.15;
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * edgeSearchDim) + ')';
    ctx.beginPath();
    ctx.moveTo(a.x ?? 0, a.y ?? 0);
    ctx.lineTo(b.x ?? 0, b.y ?? 0);
    ctx.stroke();
  }

  for (const node of (projected?.visibleNodes.values() ?? state.nodes.values())) {
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const base = node.kind === 'group'
      ? [108, 116, 132]
      : (PALETTE_REST[node.kind] || PALETTE_REST.file);
    const hover = node.kind === 'group'
      ? [168, 176, 192]
      : (PALETTE_HOVER[node.kind] || PALETTE_HOVER.file);
    const nAnim = anim.nodes.get(node.id) || { highlight: 0, colorMix: 0 };
    const isSelected = node.id === selectedId;
    const isSelectionNeighbor = selectedId !== null && (neighborsOf.get(selectedId) || new Set()).has(node.id);
    const selectionLevel = isSelected ? 1.0 : (isSelectionNeighbor ? 0.6 : 0);
    const combinedHighlight = Math.max(nAnim.highlight, selectionLevel);
    const rgb = lerpRGB(base, hover, Math.max(nAnim.colorMix, selectionLevel));
    const statusAlpha = node.status === 'proposed' || node.status === 'superseded' ? 0.4 : 1.0;
    const restAlpha  = statusAlpha * 0.5;
    const hoverAlpha = Math.min(1, statusAlpha + 0.25);
    const alpha = hoveredId === null && !isSelected && !isSelectionNeighbor
      ? statusAlpha
      : restAlpha + (hoverAlpha - restAlpha) * combinedHighlight;
    // Hover wins locally: the hovered node is never dimmed by search.
    const matches = searchMatch(node, searchQuery);
    const isHovered = node.id === hoveredId;
    const searchDim = searchQuery && !matches && !isHovered && !isSelected && !isSelectionNeighbor ? 0.15 : 1.0;

    // Rendered radius: group uses physics-size (world=8 * log factor), else use
    // sizeAt for apparent-size clamping.
    const r = node.kind === 'group'
      ? (nodeSize(node) + combinedHighlight * 1.5)
      : sizeAt(node.kind, camera.zoom) * (1 + combinedHighlight * 0.15);

    shape(ctx, node.x ?? 0, node.y ?? 0, r, rgbString(rgb, alpha * searchDim));

    if (isSelected) {
      ctx.beginPath();
      if (node.kind === 'group') ctx.rect(node.x - r - 2, node.y - r - 2, (r + 2) * 2, (r + 2) * 2);
      else ctx.arc(node.x ?? 0, node.y ?? 0, r + 2, 0, Math.PI * 2);
      ctx.strokeStyle = rgbString(hover, 0.9);
      ctx.lineWidth = 1 / camera.zoom;
      ctx.stroke();
    }
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

  for (const node of (projected?.visibleNodes.values() ?? state.nodes.values())) {
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

    if (node.kind === 'group') alpha = 1;   // groups are always labeled

    if (alpha <= 0) continue;

    // Search dim also applies to labels, but hover wins (matches node rule).
    if (searchQuery && !searchMatch(node, searchQuery) && node.id !== hoveredId) {
      alpha *= 0.15;
    }

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

    if (node.kind === 'group' && node.memberCount) {
      const countText = ' · ' + node.memberCount;
      ctx.fillStyle = 'rgba(120,120,120,' + alpha + ')';
      const nameW = ctx.measureText(String(node.name || '')).width;
      ctx.fillText(countText, sx + offset + nameW, sy + 3);
    }
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
// focusId, focusSet are declared near the top of the file (hoisted for reproject).

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
    reproject('focus-enter');
  }
});

window.addEventListener('keydown', (ev) => {
  // Esc inside the search input is handled locally (clear + blur) — leave it alone.
  if (document.activeElement === searchInput) return;
  if (ev.key !== 'Escape') return;
  // Only animate the camera if we were actually in focus mode. Otherwise Esc is a no-op.
  if (!focusSet) return;
  focusId = null;
  focusSet = null;
  targetCamera = fitToBounds(
    state.nodes.values(),
    canvas.clientWidth,
    canvas.clientHeight,
    40,
  );
  reproject('focus-exit');
});

document.getElementById('recenter-btn').addEventListener('click', recenter);

window.addEventListener('keydown', (ev) => {
  if (document.activeElement === searchInput) return;
  if (ev.key === 'f' || ev.key === 'F' || ev.key === 'r' || ev.key === 'R') {
    ev.preventDefault();
    recenter();
  }
});
