import { fetchProjects, fetchGraph, fetchDecisions, fetchAggregates, fetchFileEdges, fetchFrames, fetchTodos } from '/viewer/data-fetch.js';
import { groupNodesIntoFrames, basenames, buildFrameGovernance, withGovernedFramesRendered, frameCoverage, buildFramePathIndex, frameIdForPath, buildGovernance, buildSpawnsFromIndex, filterAmbientTodos, todoDotColor } from '/viewer/adapters.js';
import { createStore } from '/viewer/store.js';
import { connectLiveSync } from '/viewer/ws-client.js';
import { createLiveEffects } from '/viewer/live-effects.js';

(() => {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const DPR = window.devicePixelRatio || 1;

  function isLight() { return document.body.classList.contains('light'); }

  // Canvas-side theme helpers — small, intentional, not a full abstraction
  function frameBorderRGB()       { return isLight() ? [0, 0, 0]       : [255, 255, 255]; }
  function frameFillRGB()         { return isLight() ? [255, 255, 255] : [14, 14, 17]; }
  function nodeBaseRGB()          { return isLight() ? [82, 82, 91]    : [113, 113, 122]; }
  function pillBgRGB()            { return isLight() ? [255, 255, 255] : [17, 18, 27]; }
  function pillBgGreenRGB()       { return isLight() ? [250, 253, 251] : [13, 17, 14]; }
  function pillTextRGB()          { return isLight() ? [24, 24, 27]    : [237, 237, 237]; }
  function primaryLabelRGB()      { return isLight() ? [24, 24, 27]    : [237, 237, 237]; }
  function subLabelRGB()          { return isLight() ? [113, 113, 122] : [161, 161, 170]; }
  function countIdleRGB()         { return isLight() ? [161, 161, 170] : [82, 82, 91]; }

  // ── Layer lens (taxonomy milestone 1). Palette softened ~20% toward
  // neutral; values pinned by the approved design spec. Off = the exact
  // pre-existing draw constants (pixel-identical).
  // Ceremony is a WARM dim taupe (observe-phase fix, 2026-06-13): the
  // original cool gray was indistinguishable from infrastructure's slate at
  // lens alphas — warm-vs-cool separates where lightness alone washed out.
  const LAYER_RGB = {
    interface:      [92, 161, 237],
    orchestration:  [171, 130, 237],
    domain:         [234, 186, 95],
    data:           [92, 204, 167],
    infrastructure: [131, 141, 163],
    ceremony:       [125, 110, 93],
  };
  const LAYERS_LS_KEY = 'cortex.viewer.layers';
  let layersOn = false;
  try { layersOn = localStorage.getItem(LAYERS_LS_KEY) === '1'; } catch { /* sandboxed */ }

  const SHOW_LS = {
    frames: 'cortex.viewer.show.frames',
    decisions: 'cortex.viewer.show.decisions',
    todos: 'cortex.viewer.show.todos',
  };
  function readShow(key) {
    try { return localStorage.getItem(key) !== '0'; } catch { return true; } // default ON
  }
  let showFrames = readShow(SHOW_LS.frames);
  let showDecisions = readShow(SHOW_LS.decisions);
  let showTodos = readShow(SHOW_LS.todos);

  function agentAUserRGB()        { return isLight() ? [24, 24, 27]    : [237, 237, 237]; }
  function hoverPillBgRGB()       { return isLight() ? [24, 24, 27]    : [237, 237, 237]; }
  function hoverPillTextPrimaryRGB() { return isLight() ? [237, 237, 237] : [24, 24, 27]; }
  function hoverPillTextSecondaryRGB() { return isLight() ? [161, 161, 170] : [82, 82, 91]; }
  function branchGlyphRGB()       { return isLight() ? [124, 58, 237]  : [192, 132, 252]; }
  function additionsRGB()         { return isLight() ? [22, 163, 74]   : [134, 239, 172]; }
  function decisionDotRGB()       { return isLight() ? [22, 163, 74]   : [74, 222, 128]; }
  function decisionTextRGB()      { return isLight() ? [22, 163, 74]   : [134, 239, 172]; }
  function prDotRGB()             { return isLight() ? [79, 70, 229]   : [129, 140, 248]; }
  function prDotMergedRGB()       { return isLight() ? [67, 56, 202]   : [79, 70, 229]; }
  function prTextRGB()            { return isLight() ? [79, 70, 229]   : [165, 180, 252]; }
  function amberRGB()             { return [245, 158, 11]; }
  function todoDotRGB()           { return [250, 204, 21]; }
  function todoTextRGB()          { return [250, 204, 21]; }

  // Display id for a decision: prefer the friendly seq form, fall back to canonical id.
  function decisionDisplayId(d) {
    return (d.seq != null) ? ('D-' + d.seq) : d.id;
  }

  // Display id for a todo: prefer the friendly seq form, fall back to canonical id.
  function todoDisplayId(t) {
    return (t.seq != null) ? ('T-' + t.seq) : t.id;
  }

  // Max file-dots rendered per frame. Raising it surfaces more nodes per frame
  // and, because edges only draw between visible dots, recovers more of the
  // graph's connectivity on the map (the cap is the dominant edge filter).
  const MAX_FRAME_NODES = 22;

  let FRAMES = [];
  let NODE_CFG = {};
  let FILE_NAMES = {};
  let FRAME_FILE_PATHS = {};
  // file_path → frameIdStr, for matching decision-governed file paths to the
  // frame that actually contains the file (membership, not label resemblance).
  let FRAME_PATH_INDEX = new Map();

  const nodes = [];
  const edges = [];
  const adjacency = {};

  let focusedFrameId = null;
  let focusT0 = 0;
  const FOCUS_DURATION = 550;
  let previousFocusId = null;

  const store = createStore();
  const liveFx = createLiveEffects({
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  });
  const DECISIONS = store.state.decisions; // aliases — object identity is stable
  let FRAME_GOVERNANCE = {};
  const TODOS = store.state.todos;
  let TODO_GOVERNANCE = {};
  let SPAWNS_FROM = {};
  let AGGREGATES = [];
  let FILE_EDGES = [];

  // Freshest server head, tracked from the sync client's hello/resnapshot so
  // loadGraph can seed the store cursor when viewing the live-bound project.
  // Slightly-stale is safe — deltas re-derive current state at catch-up time.
  let lastKnownHead = null;
  // Cached frame metadata from the last loadGraph, used by the incremental
  // apply path to recompute promoted-frame overlays without a full reload.
  let lastFrameMeta = null;

  function getDecision(id) { return DECISIONS[id]; }
  function getFrameDecisions(frameId) {
    return (FRAME_GOVERNANCE[frameId] || []).map(getDecision).filter(Boolean);
  }
  function getFrameTodos(frameId) {
    return (TODO_GOVERNANCE[frameId] || []).map((id) => TODOS[id]).filter(Boolean);
  }

  let currentProject = null;

  // Zero-frames warning: shown when a project has file nodes but none are
  // framed (graph built by the raw C indexer, which skips frame extraction).
  // Re-evaluated on every loadGraph; dismiss only hides until next load.
  function updateFramesWarning(nodes) {
    const el = document.getElementById('frames-warning');
    if (!el) return;
    const { zeroFrames, fileNodes } = frameCoverage(nodes);
    if (zeroFrames) {
      const text = document.getElementById('frames-warning-text');
      if (text) {
        text.textContent = '';
        text.append(`${fileNodes} files indexed, 0 frames — reindex via `);
        const code = document.createElement('code');
        code.textContent = 'cortex index';
        text.append(code, ' to generate frames.');
      }
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  async function loadGraph(projectName) {
    currentProject = projectName;
    const [graph, decs, aggs, fileEdges, frameMap, todosResp] = await Promise.all([
      fetchGraph(projectName),
      fetchDecisions(projectName),
      fetchAggregates(projectName),
      fetchFileEdges(projectName),
      fetchFrames(projectName),
      fetchTodos(projectName),
    ]);
    AGGREGATES = aggs.aggregates || [];
    FILE_EDGES = fileEdges.file_edges || [];

    // 1. Build frame summaries from the graph.
    const summaries = groupNodesIntoFrames(graph.nodes);
    FRAME_PATH_INDEX = buildFramePathIndex(summaries);
    updateFramesWarning(graph.nodes);

    // 2. Consume server-computed force-directed positions. All positioned frames
    //    (ambient + non-ambient) are rendered; non-ambient ones are tagged
    //    deemphasized so drawFrames can reduce their visual prominence.
    //    Positions are integer px in a fixed virtual stage; the viewer normalizes
    //    by the stage dims the server reports.
    const stage = frameMap.stage || { w: 1000, h: 800 };
    FRAMES = (frameMap.frames || [])
      .filter((f) => f.x !== null && f.y !== null)
      .map((f) => ({
        id: String(f.id),
        name: f.name,
        x: f.x / stage.w,
        y: f.y / stage.h,
        w: f.w,
        h: f.h,
        count: f.count,
        layer: f.layer,
        deemphasized: !f.ambient,
      }));

    // 4. NODE_CFG.count = how many file basenames to show per frame (cap at
    //    MAX_FRAME_NODES). Track the canonical file_path alongside the basename
    //    so edge lookups don't have to disambiguate by basename alone.
    NODE_CFG = {};
    FILE_NAMES = {};
    FRAME_FILE_PATHS = {};
    for (const s of summaries) {
      const sid = String(s.frame_id);
      const visibleMembers = s.members.slice(0, MAX_FRAME_NODES);
      NODE_CFG[sid] = { count: visibleMembers.length };
      FILE_NAMES[sid] = basenames(visibleMembers, MAX_FRAME_NODES);
      FRAME_FILE_PATHS[sid] = visibleMembers.map((m) => m.file_path || null);
    }

    // 5. Decisions + TODOs → the reactive store (single owner). Hydrate
    // mutates the aliased objects (DECISIONS/TODOS) in place; cursor comes from
    // the sync client when this is the server-bound live project.
    // buildGovernance only picks up kind:'frame' refs; for todos that only have
    // kind:'file' governs, we also resolve file paths to frame ids via
    // FRAME_PATH_INDEX (same path the draw layer uses for decisions).
    const ambientTodos = filterAmbientTodos(todosResp.todos || []);
    const decMap = {};
    for (const d of decs.decisions) decMap[d.id] = d;
    const todoMap = {};
    for (const t of ambientTodos) todoMap[t.id] = t;
    store.hydrate({
      decisions: decMap,
      todos: todoMap,
      cursor: (syncClient && projectName === syncClient.boundProject) ? lastKnownHead : null,
    });
    FRAME_GOVERNANCE = buildFrameGovernance(decs.decisions);
    TODO_GOVERNANCE = buildGovernance(ambientTodos);
    // Augment with file-path-resolved frame governs.
    for (const t of ambientTodos) {
      for (const g of t.governs || []) {
        if (g.kind !== 'file') continue;
        const fid = frameIdForPath(FRAME_PATH_INDEX, g.path);
        if (!fid) continue;
        if (!TODO_GOVERNANCE[fid]) TODO_GOVERNANCE[fid] = [];
        if (!TODO_GOVERNANCE[fid].includes(t.id)) TODO_GOVERNANCE[fid].push(t.id);
      }
    }
    SPAWNS_FROM = buildSpawnsFromIndex(todosResp.todos || []);

    // 5b. A decision-governed frame the ranking left non-ambient would never
    //     render, hiding its decisions (e.g. cortex-indexer's governed frames
    //     were all non-ambient). Promote any such frame into the render set.
    const frameMeta = new Map(
      (frameMap.frames || []).map((f) => [
        String(f.id),
        { name: f.name, w: f.w, h: f.h, count: f.count, layer: f.layer },
      ]),
    );
    lastFrameMeta = frameMeta;
    FRAMES = withGovernedFramesRendered(FRAMES, FRAME_GOVERNANCE, frameMeta);

    // 6. Rebuild the in-canvas graph (re-uses existing buildGraph; that fn
    // already reads from FRAMES/NODE_CFG/FILE_NAMES/FRAME_GOVERNANCE/DECISIONS).
    buildGraph();
    focusedFrameId = null;
    previousFocusId = null;
  }

  async function initToolbar() {
    const select = document.getElementById('project-select');
    const themeToggle = document.getElementById('theme-toggle');
    const { projects, active } = await fetchProjects();
    select.innerHTML = '';
    if (projects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no projects)';
      opt.disabled = true;
      select.appendChild(opt);
    }
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      if (p.name === active) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', async () => {
      await loadGraph(select.value || null);
      showSyncStatus(lastSyncStatus);
    });
    themeToggle.addEventListener('click', () => document.body.classList.toggle('light'));

    const layersBtn = document.getElementById('layers-toggle');
    const layersMenu = document.getElementById('layers-menu');
    const layersSwitch = document.getElementById('layers-switch');
    layersSwitch.classList.toggle('on', layersOn);
    layersSwitch.setAttribute('aria-checked', String(layersOn));
    // Legend swatches derive from LAYER_RGB — the palette's single runtime
    // source. (The CSS used to carry a second hand-synced copy; it drifted.)
    layersMenu.querySelectorAll('.lm-row i[data-layer]').forEach((sw) => {
      const rgb = LAYER_RGB[sw.dataset.layer];
      if (rgb) sw.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    });
    layersBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layersMenu.hidden = !layersMenu.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!layersMenu.hidden && !layersMenu.contains(e.target) && e.target !== layersBtn) {
        layersMenu.hidden = true;
      }
    });
    layersSwitch.addEventListener('click', () => {
      layersOn = !layersOn;
      layersSwitch.classList.toggle('on', layersOn);
      layersSwitch.setAttribute('aria-checked', String(layersOn));
      try { localStorage.setItem(LAYERS_LS_KEY, layersOn ? '1' : '0'); } catch { /* sandboxed */ }
    });
    layersSwitch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        layersSwitch.click();
      }
    });

    const bindSwitch = (el, lsKey, get, set) => {
      el.classList.toggle('on', get());
      el.setAttribute('aria-checked', String(get()));
      const toggle = () => {
        set(!get());
        el.classList.toggle('on', get());
        el.setAttribute('aria-checked', String(get()));
        try { localStorage.setItem(lsKey, get() ? '1' : '0'); } catch { /* sandboxed */ }
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    };
    bindSwitch(document.getElementById('show-frames'), SHOW_LS.frames,
      () => showFrames, (v) => { showFrames = v; });
    bindSwitch(document.getElementById('show-decisions'), SHOW_LS.decisions,
      () => showDecisions, (v) => { showDecisions = v; });
    bindSwitch(document.getElementById('show-todos'), SHOW_LS.todos,
      () => showTodos, (v) => { showTodos = v; });

    const framesDismiss = document.getElementById('frames-warning-dismiss');
    if (framesDismiss) {
      framesDismiss.addEventListener('click', () => {
        const el = document.getElementById('frames-warning');
        if (el) el.hidden = true;
      });
    }

    await loadGraph(active);
  }

  /** Entity-only resync (decisions + todos + frame map for promotion), used as
   *  the sync client's snapshot bootstrap/fallback. Cheaper than loadGraph —
   *  the structural graph doesn't change on the projection channel. */
  async function resyncEntities(headUlid) {
    lastKnownHead = headUlid ?? lastKnownHead;
    const project = currentProject;
    const [decs, todosResp] = await Promise.all([fetchDecisions(project), fetchTodos(project)]);
    const ambientTodos = filterAmbientTodos(todosResp.todos || []);
    const decMap = {}; for (const d of decs.decisions) decMap[d.id] = d;
    const todoMap = {}; for (const t of ambientTodos) todoMap[t.id] = t;
    store.hydrate({ decisions: decMap, todos: todoMap, cursor: headUlid ?? null });
    FRAME_GOVERNANCE = buildFrameGovernance(decs.decisions);
    TODO_GOVERNANCE = buildGovernance(ambientTodos);
    for (const t of ambientTodos) {
      for (const g of t.governs || []) {
        if (g.kind !== 'file') continue;
        const fid = frameIdForPath(FRAME_PATH_INDEX, g.path);
        if (!fid) continue;
        if (!TODO_GOVERNANCE[fid]) TODO_GOVERNANCE[fid] = [];
        if (!TODO_GOVERNANCE[fid].includes(t.id)) TODO_GOVERNANCE[fid].push(t.id);
      }
    }
    SPAWNS_FROM = buildSpawnsFromIndex(todosResp.todos || []);
    if (lastFrameMeta) FRAMES = withGovernedFramesRendered(FRAMES.filter((f) => !f.promotedForGovernance), FRAME_GOVERNANCE, lastFrameMeta);
    buildGraph();
  }

  const syncIndicatorEl = document.getElementById('sync-indicator');
  function showSyncStatus(status) {
    if (!syncIndicatorEl) return;
    const onLiveProject = syncClient && currentProject === syncClient.boundProject;
    syncIndicatorEl.hidden = !onLiveProject;
    if (!onLiveProject) return;
    syncIndicatorEl.className = `sync-indicator ${status}`;
    syncIndicatorEl.querySelector('.word').textContent = status;
  }
  let lastSyncStatus = 'offline';

  const syncClient = connectLiveSync({
    wsUrl: `ws://${location.host}/ws`,
    store,
    isLiveProject: () => currentProject === syncClient.boundProject,
    resnapshot: resyncEntities,
    onStatus: (s) => { lastSyncStatus = s; showSyncStatus(s); },
  });

  // Deterministic placement primitives: same graph → same dot positions on
  // every load (no Math.random in the render data path), and a jitter-bounded
  // grid guarantees dots never land close enough to read as one dot — which
  // previously made a hub's distinct edges look like duplicate edges to the
  // same target. Same seeding approach as the server frame layout (D-pzc8).
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Usable dot area inside a frame box (normalized), matching the previous
  // rand() bounds so the visual envelope is unchanged.
  const DOT_AREA = { x0: 0.16, x1: 0.84, y0: 0.22, y1: 0.78 };
  // Jitter stays within ±JITTER of a cell's extent, so axis-aligned neighbors
  // are always ≥ (1 − 2·JITTER) = 0.4 cells apart (diagonal neighbors more) —
  // never coincident.
  const DOT_JITTER = 0.3;

  /** Grid cell + seeded jitter for dot i of n in a frame. Jitter is seeded
   *  from the file path (stable across reloads and member reordering); the
   *  cell comes from the member index. */
  function dotPosition(i, n, seedStr) {
    const w = DOT_AREA.x1 - DOT_AREA.x0;
    const h = DOT_AREA.y1 - DOT_AREA.y0;
    // Clamp cols to n so small frames (esp. n=1) stay centered, not left-biased.
    const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * (w / h)))));
    const rows = Math.max(1, Math.ceil(n / cols));
    const cw = w / cols;
    const ch = h / rows;
    const rng = mulberry32(fnv1a(seedStr));
    const cx = DOT_AREA.x0 + (i % cols) * cw + cw / 2;
    const cy = DOT_AREA.y0 + Math.floor(i / cols) * ch + ch / 2;
    return {
      rx: cx + (rng() * 2 - 1) * cw * DOT_JITTER,
      ry: cy + (rng() * 2 - 1) * ch * DOT_JITTER,
    };
  }

  function buildGraph() {
    nodes.length = 0; edges.length = 0;
    Object.keys(adjacency).forEach(k => delete adjacency[k]);

    FRAMES.forEach(frame => {
      const cfg = NODE_CFG[frame.id] || { count: 0 };
      const paths = FRAME_FILE_PATHS[frame.id] || [];
      const names = FILE_NAMES[frame.id] || [];
      for (let i = 0; i < cfg.count; i++) {
        const pos = dotPosition(i, cfg.count, paths[i] || frame.id + '-' + i);
        nodes.push({
          id: frame.id + '-' + i,
          frameId: frame.id,
          kind: 'file',
          file_path: paths[i] || null,
          rx: pos.rx,
          ry: pos.ry,
          name: names[i] || 'n-' + i,
        });
        adjacency[nodes.length - 1] = [];
      }
    });

    function addEdge(a, b, interFrame, weight) {
      const edge = { a, b, intensity: 0, interFrame, weight: weight || 1 };
      edges.push(edge);
      adjacency[a].push({ to: b, edge: edges.length - 1 });
      adjacency[b].push({ to: a, edge: edges.length - 1 });
    }

    // Build path → canvas-index lookup for the visible (capped) nodes.
    const pathToIdx = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i].file_path;
      if (p) pathToIdx.set(p, i);
    }

    // Real edges from /api/file-edges. Each FileEdge already has a weight
    // (count of underlying entity-level CALLS, threshold ≥ 2 server-side).
    // Edges where either endpoint isn't on canvas (file beyond the per-frame
    // cap MAX_FRAME_NODES, or in noise / auxiliary content) are silently dropped.
    for (const fe of FILE_EDGES) {
      const a = pathToIdx.get(fe.from_path);
      const b = pathToIdx.get(fe.to_path);
      if (a === undefined || b === undefined) continue;
      addEdge(a, b, nodes[a].frameId !== nodes[b].frameId, fe.weight);
    }

    // Generalized seeded anchor picker: same entity + frame → same anchor dots
    // every load (deterministic, was Math.random shuffle).
    // Decision prefix '' reproduces the prior seed string (decId + ':' + frameId)
    // byte-for-byte so decision anchors never move. TODOs use 'todo:' prefix to
    // give them an independent seed space.
    const assignAnchors = (governance, entityMap, prefix) => {
      for (const frameId in governance) {
        governance[frameId].forEach((entId) => {
          const ent = entityMap[entId];
          if (ent) assignAnchorsForEntity(ent, frameId, prefix);
        });
      }
    };
    assignAnchors(FRAME_GOVERNANCE, DECISIONS, '');       // unchanged seed → identical decision anchors
    assignAnchors(TODO_GOVERNANCE, TODOS, 'todo:');       // namespaced seed → independent todo anchors
  }

  // Deterministic per-entity anchor pick — same seeding as the bulk pass in
  // buildGraph, so incremental assignment for one entity is bit-identical.
  function assignAnchorsForEntity(ent, frameId, prefix) {
    const frameNodes = nodes.map((n, i) => ({ n, i })).filter(o => o.n.frameId === frameId);
    if (!frameNodes.length) { ent._nodeIdxs = []; return; }
    const rng = mulberry32(fnv1a(prefix + ent.id + ':' + frameId));
    const targetCount = Math.min(2 + Math.floor(rng() * 2), frameNodes.length);
    const pool = [...frameNodes];
    const picked = [];
    for (let k = 0; k < targetCount; k++) {
      picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    ent._nodeIdxs = picked.map(o => o.i);
  }

  /** Frames (string ids) an entity governs, resolved the same way the bulk
   *  loaders do: kind:'frame' refs directly; kind:'file' refs via membership. */
  function governedFrameIdsOf(ent) {
    const out = [];
    for (const g of ent.governs || []) {
      let fid = null;
      if (g.kind === 'frame') fid = String(g.id);
      else if (g.kind === 'file') fid = frameIdForPath(FRAME_PATH_INDEX, g.path);
      if (fid && !out.includes(fid)) out.push(fid);
    }
    return out;
  }

  /** Incrementally rebuild one entity's governance entries + anchors. */
  function applyGovernanceFor(entity, id) {
    const gov = entity === 'decision' ? FRAME_GOVERNANCE : TODO_GOVERNANCE;
    const map = entity === 'decision' ? DECISIONS : TODOS;
    const prefix = entity === 'decision' ? '' : 'todo:';
    for (const fid of Object.keys(gov)) {
      const i = gov[fid].indexOf(id);
      if (i !== -1) gov[fid].splice(i, 1);
      if (gov[fid].length === 0) delete gov[fid];
    }
    const ent = map[id];
    if (!ent) return;
    for (const fid of governedFrameIdsOf(ent)) {
      if (!gov[fid]) gov[fid] = [];
      if (!gov[fid].includes(id)) gov[fid].push(id);
      assignAnchorsForEntity(ent, fid, prefix); // last frame wins — matches bulk pass
    }
  }

  // Live-effects trigger: translate applied deltas into transient treatment
  // state (frame heat, dot birth/halo/leader fire, tombstones, presence pills).
  // Gating: skip when the change didn't animate (hidden tab, load-time hydrate),
  // and skip entities whose layer toggle is off. A remove whose prev is undefined
  // was never rendered — there's no dot to tombstone, so skip it outright.
  let onLiveChangesApplied = (changes) => {
    const now = performance.now();
    for (const c of changes) {
      if (!c.animate) continue;
      if (c.entity === 'decision' && !showDecisions) continue;
      if (c.entity === 'todo' && !showTodos) continue;
      const ent = c.next ?? c.prev;
      if (!ent) continue; // never-rendered remove (prev === undefined)
      liveFx.noteChange({
        kind: c.op === 'remove' ? 'remove' : (c.prev === undefined ? 'create' : 'update'),
        entity: c.entity,
        id: c.id,
        frameIds: governedFrameIdsOf(ent),
        actor: c.next?.proposedBy ?? c.prev?.proposedBy ?? 'claude',
        now,
      });
    }
  };

  const removedRecordSnapshots = {};

  /** Incrementally maintain SPAWNS_FROM for one todo. Mirrors the load-path
   *  semantics (built from the FULL todo list): a todo that closes
   *  (done/cancelled) keeps its entry — only a server-side remove drops it.
   *  Pass ent = the todo's latest shape, or undefined to drop its entry. */
  function updateSpawnsFromFor(id, ent) {
    for (const k of Object.keys(SPAWNS_FROM)) {
      const i = SPAWNS_FROM[k].indexOf(id);
      if (i !== -1) SPAWNS_FROM[k].splice(i, 1);
      if (SPAWNS_FROM[k].length === 0) delete SPAWNS_FROM[k];
    }
    const parent = ent && ent.spawnsFrom;
    if (parent) {
      if (!SPAWNS_FROM[parent]) SPAWNS_FROM[parent] = [];
      if (!SPAWNS_FROM[parent].includes(id)) SPAWNS_FROM[parent].push(id);
    }
  }

  function applyLiveChanges(changes) {
    const renderedFrames = new Set(FRAMES.map((f) => String(f.id)));
    let needsPromotionRebuild = false;

    for (const c of changes) {
      let ambientClosed = false;
      if (c.entity === 'todo' && c.next && (c.next.state === 'done' || c.next.state === 'cancelled')) {
        // Ambient filter: closed todos leave the canvas (same rule as load).
        // Update SPAWNS_FROM before nulling c.next so the closed todo keeps its
        // entry (load-path parity: load builds from the FULL list including done/cancelled).
        updateSpawnsFromFor(c.id, c.next);
        delete TODOS[c.id];
        c.op = 'remove';
        c.next = undefined;
        ambientClosed = true;
      }
      applyGovernanceFor(c.entity, c.id);
      // ambientClosed already kept its SPAWNS_FROM entry above — the generic
      // remove branch below must not drop it (that's for server-side removes).
      if (c.entity === 'todo' && !ambientClosed) {
        if (c.op === 'remove') {
          // True server-side remove: drop the entry entirely.
          updateSpawnsFromFor(c.id, undefined);
        } else if (c.next) {
          // Upsert (open todo): update to reflect any spawnsFrom change.
          updateSpawnsFromFor(c.id, c.next);
        }
      }
      for (const fid of c.next ? governedFrameIdsOf(c.next) : []) {
        if (!renderedFrames.has(fid)) needsPromotionRebuild = true;
      }
      // Removed-while-open: keep the card up with a quiet removed note.
      if (c.op === 'remove' && focusedRecord && focusedRecord.type === c.entity && focusedRecord.id === c.id) {
        removedRecordSnapshots[c.id] = c.prev;
        currentRenderedRecord = null; // force re-render with the note
      }
    }

    if (needsPromotionRebuild && lastFrameMeta) {
      // Rare path: a change governs a frame outside the render set — recompute
      // the promoted-frames overlay + canvas graph (documented spec exception).
      FRAMES = withGovernedFramesRendered(FRAMES.filter((f) => !f.promotedForGovernance), FRAME_GOVERNANCE, lastFrameMeta);
      buildGraph();
    }
    onLiveChangesApplied(changes);
  }
  store.subscribe(applyLiveChanges);

  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function computeFocusProgress() {
    if (!focusedFrameId && !previousFocusId) return { t: 0, focused: null, from: null };
    const dt = performance.now() - focusT0;
    const raw = Math.min(1, dt / FOCUS_DURATION);
    // Once the transition completes, drop the from-state. Keeping it alive made
    // drawFrames render the defocused frame's marginalia at alpha 0 forever,
    // leaving invisible-but-hoverable pill hit rects on the canvas.
    if (raw >= 1) previousFocusId = null;
    const t = ease(raw);
    return { t, focused: focusedFrameId, from: previousFocusId };
  }

  // Keep-out margins so frames stay clear of the canvas edges and the UI
  // chrome layered over them (the toolbar / project switcher up top, the
  // aggregate strip along the bottom). The frame LABEL is drawn above the box
  // top (see primaryY = -h/2 - 7), so the top keep-out adds LABEL_HEADROOM on
  // top of EDGE_MARGIN to keep the label itself off the edge — otherwise a
  // frame whose box sits exactly at 40px still has its label tucked under the
  // toolbar.
  const EDGE_MARGIN = 40;
  const LABEL_HEADROOM = 16;
  // Server virtual stage (matches frameMap.stage); frame/aggregate fractions are
  // positions ÷ these dims.
  const STAGE = { w: 1000, h: 800 };
  /** Floor for the fit scale so a pathologically small canvas (e.g. a collapsed
   *  panel mid-resize, where the usable band goes ≤ 0) can never produce a zero
   *  or negative scale that would mirror/collapse the whole scene. */
  const MIN_VIEW_SCALE = 0.05;
  /** Uniform aggregate dot radius (px, before the view scale). Aggregates are not
   *  sized by member_count — the count shows as a numeric badge beneath the dot. */
  const AGG_DOT_R = 5;

  /** Virtual-stage fraction (0..1) of an aggregate, with the tie-less fallback —
   *  the SINGLE source of this mapping, shared by the fit transform and the
   *  draw pass so the measured bbox always matches what is rendered. */
  function aggregateFraction(agg, i, total) {
    return {
      nx: typeof agg.x === "number" ? agg.x / STAGE.w : (i + 0.5) / Math.max(total, 1),
      ny: typeof agg.y === "number" ? agg.y / STAGE.h : 0.96,
    };
  }

  // Fit-to-content view transform. The server lays frames out in a fixed virtual
  // stage; mapping that stage edge-to-edge onto the canvas means any imbalance in
  // the layout (a left/right lean, bottom-heaviness) shows directly. Instead we
  // center the frames' CENTER OF MASS (area-weighted centroid) in the canvas and
  // scale to fit the frame extent — so the composed scene reads as visually
  // centered regardless of where the deterministic layout placed things.
  //
  // We center the centroid, NOT the bounding-box center: the eye tracks the mass,
  // and a few sparse outliers (e.g. an aggregate dot flung to the stage edge by
  // the keep-out) would skew a bbox-center while barely moving the mass. For the
  // same reason the framing is driven by FRAMES only — the small auxiliary
  // aggregate dots annotate the cloud and must not drive the fit (drawAggregates
  // clamps them on-canvas so excluding them here can never push one off-screen).
  // Scaling by the larger half-extent measured FROM the centroid guarantees the
  // frame content never clips. Capped at 1 (never magnify), recomputed each frame
  // from the UNFOCUSED base positions (independent of focus animation → stable).
  let viewTransform = { scale: 1, ox: 0, oy: 0 };

  function computeViewTransform() {
    const stageW = canvas.clientWidth || 1;
    const stageH = canvas.clientHeight || 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let sw = 0, scx = 0, scy = 0; // area-weighted centroid accumulators
    for (const f of FRAMES) {
      const cx = f.x * stageW, cy = f.y * stageH, hw = f.w / 2, hh = f.h / 2;
      if (cx - hw < minX) minX = cx - hw;
      if (cx + hw > maxX) maxX = cx + hw;
      if (cy - hh < minY) minY = cy - hh;
      if (cy + hh > maxY) maxY = cy + hh;
      const w = Math.max(1, f.w * f.h); // frame area → mass weight
      sw += w; scx += cx * w; scy += cy * w;
    }
    if (!isFinite(minX) || sw <= 0) return { scale: 1, ox: 0, oy: 0 }; // no frames yet

    const cenX = scx / sw, cenY = scy / sw; // center of mass
    // Asymmetric vertical padding: extra room up top for the frame labels (drawn
    // above each box) and the toolbar chrome.
    const PAD = EDGE_MARGIN;
    const TOP_EXTRA = LABEL_HEADROOM + 14;
    const availHalfW = Math.max(1, (stageW - 2 * PAD) / 2);
    const availHalfH = Math.max(1, (stageH - 2 * PAD - TOP_EXTRA) / 2);
    // Half-extent measured FROM the centroid (not the bbox half-width): scaling by
    // this keeps every frame inside the padded band while the centroid sits dead
    // center — so an off-center mass is corrected, not just re-framed.
    const halfX = Math.max(cenX - minX, maxX - cenX, 1);
    const halfY = Math.max(cenY - minY, maxY - cenY, 1);
    // Cap at 1 (never magnify), floor at MIN_VIEW_SCALE (never invert/collapse).
    const scale = Math.max(MIN_VIEW_SCALE, Math.min(availHalfW / halfX, availHalfH / halfY, 1));
    const bandCy = (PAD + TOP_EXTRA + (stageH - PAD)) / 2; // center of the usable vertical band
    return { scale, ox: stageW / 2 - cenX * scale, oy: bandCy - cenY * scale };
  }

  function framePxBase(frame) {
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const v = viewTransform;
    // Map the virtual-stage fraction to raw canvas px, then apply the
    // fit-to-content transform (centers the scene; clamping is unnecessary —
    // the transform already keeps all content within the padded canvas).
    return {
      cx: (frame.x * stageW) * v.scale + v.ox,
      cy: (frame.y * stageH) * v.scale + v.oy,
      w: frame.w * v.scale,
      h: frame.h * v.scale,
    };
  }

  function framePxFocused(frame, focusedId) {
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const isFocused = frame.id === focusedId;

    const cxCanvas = stageW / 2;
    const cyCanvas = stageH / 2;

    if (isFocused) {
      const targetW = Math.min(stageW * 0.55, 560);
      const targetH = Math.min(stageH * 0.55, 360);
      return { cx: cxCanvas, cy: cyCanvas, w: targetW, h: targetH };
    }

    const base = framePxBase(frame);
    const dx = base.cx - cxCanvas;
    const dy = base.cy - cyCanvas;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    const focusedFrame = FRAMES.find(f => f.id === focusedId);
    if (!focusedFrame) return base;
    const focusedW = Math.min(stageW * 0.55, 560);
    const focusedH = Math.min(stageH * 0.55, 360);

    const compressedW = frame.w * 0.55;
    const compressedH = frame.h * 0.55;

    const targetDistX = focusedW / 2 + compressedW / 2 + 40;
    const targetDistY = focusedH / 2 + compressedH / 2 + 30;

    const pushRatio = Math.max(targetDistX / Math.max(Math.abs(dx), 1), targetDistY / Math.max(Math.abs(dy), 1));
    let newCx = cxCanvas + ux * dist * Math.max(1, pushRatio * 0.9);
    let newCy = cyCanvas + uy * dist * Math.max(1, pushRatio * 0.9);

    const pad = EDGE_MARGIN;
    newCx = Math.max(compressedW / 2 + pad, Math.min(stageW - compressedW / 2 - pad, newCx));
    newCy = Math.max(compressedH / 2 + pad + LABEL_HEADROOM, Math.min(stageH - compressedH / 2 - pad, newCy));

    return { cx: newCx, cy: newCy, w: compressedW, h: compressedH };
  }

  function framePx(frame) {
    const fp = computeFocusProgress();
    const base = framePxBase(frame);

    if (!fp.focused && !fp.from) return base;

    const target = fp.focused
      ? framePxFocused(frame, fp.focused)
      : base;

    const source = fp.from
      ? framePxFocused(frame, fp.from)
      : base;

    if (fp.t >= 1) return target;

    return {
      cx: source.cx + (target.cx - source.cx) * fp.t,
      cy: source.cy + (target.cy - source.cy) * fp.t,
      w:  source.w  + (target.w  - source.w)  * fp.t,
      h:  source.h  + (target.h  - source.h)  * fp.t,
    };
  }

  function nodePx(node) {
    const frame = FRAMES.find(f => f.id === node.frameId);
    const f = framePx(frame);
    return {
      x: f.cx - f.w / 2 + node.rx * f.w,
      y: f.cy - f.h / 2 + node.ry * f.h,
    };
  }

  let hoveredLabelFrameId = null;
  let hoveredFrameId = null;
  let hoveredNodeIdx = null;
  let hoveredMarginaliaId = null;
  let hoveredDecisionId = null;
  let hoveredTodoId = null;
  let hoveredAggregateId = null;
  let nodeHoverT0 = 0;
  const NODE_HOVER_DELAY = 60;
  const NODE_HOVER_IN_MS = 140;
  const NODE_HOVER_OUT_MS = 180;
  let nodeHoverLeaveT0 = 0;
  let lastHoveredNodeIdx = null;

  let pinnedNodeIdx = null;
  let pinnedT0 = 0;
  let pinnedLeavingT0 = 0;
  let lastPinnedNodeIdx = null;
  const PIN_IN_MS = 180;
  const PIN_OUT_MS = 220;

  let anchorNodeIdx = null;

  let focusedRecord = null;
  let recordDrawerT0 = 0;
  let previousRecord = null;
  const RECORD_DRAWER_DURATION = 360;

  function openRecord(type, id) {
    if (focusedRecord && focusedRecord.type === type && focusedRecord.id === id) return;
    previousRecord = focusedRecord;
    focusedRecord = { type, id };
    recordDrawerT0 = performance.now();
  }

  function closeRecord() {
    if (focusedRecord === null) return;
    previousRecord = focusedRecord;
    focusedRecord = null;
    recordDrawerT0 = performance.now();
    for (const k of Object.keys(removedRecordSnapshots)) delete removedRecordSnapshots[k];
  }

  function openDecisionCard(decId) { openRecord('decision', decId); }
  function closeDecisionCard() { closeRecord(); }
  function currentDecisionId() {
    return focusedRecord && focusedRecord.type === 'decision' ? focusedRecord.id : null;
  }

  const frameHoverState = {};

  const HOVER_IN_MS = 180;
  const HOVER_OUT_MS = 220;

  function resize() {
    canvas.width = canvas.clientWidth * DPR;
    canvas.height = canvas.clientHeight * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);

  function marginaliaAtPoint(px, py) {
    for (const r of marginaliaRects) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return r;
      }
    }
    return null;
  }

  function nodeAtPoint(px, py) {
    const fp = computeFocusProgress();
    const focusedId = fp.focused;

    let best = null;
    let bestDist = Infinity;
    nodes.forEach((n, i) => {
      const p = nodePx(n);
      const frame = FRAMES.find(f => f.id === n.frameId);
      const inFocused = focusedId && frame?.id === focusedId;
      const sizeMult = inFocused ? 1 + 0.4 * fp.t : (fp.from && frame?.id === fp.from ? 1 + 0.4 * (1 - fp.t) : 1);
      const baseR = n.kind === 'decision' ? 2.8 : 2.2;
      const hitR = baseR * sizeMult + 4;
      const d = Math.hypot(p.x - px, p.y - py);
      if (d <= hitR && d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  function frameAtPoint(px, py) {
    for (let i = FRAMES.length - 1; i >= 0; i--) {
      const frame = FRAMES[i];
      const f = framePx(frame);
      if (px >= f.cx - f.w / 2 && px <= f.cx + f.w / 2 &&
          py >= f.cy - f.h / 2 && py <= f.cy + f.h / 2) {
        return frame;
      }
    }
    return null;
  }

  function frameLabelAtPoint(px, py) {
    for (const frame of FRAMES) {
      const f = framePx(frame);
      const labelY = f.cy - f.h / 2 - 15;
      const labelX = f.cx - f.w / 2;
      if (px >= labelX && px <= labelX + f.w &&
          py >= labelY - 10 && py <= labelY + 10) {
        return frame;
      }
    }
    return null;
  }

  function setFocus(frameId) {
    if (focusedFrameId === frameId) return;
    previousFocusId = focusedFrameId;
    focusedFrameId = frameId;
    focusT0 = performance.now();
    if (frameId === null) anchorNodeIdx = null;
  }

  let mouseX = 0, mouseY = 0;

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    mouseX = px; mouseY = py;

    const marginaliaHit = marginaliaAtPoint(px, py);
    const nodeIdx = marginaliaHit ? null : nodeAtPoint(px, py);
    const labelFrame = (marginaliaHit || !showFrames) ? null : frameLabelAtPoint(px, py);
    const bodyFrame = (marginaliaHit || !showFrames) ? null : frameAtPoint(px, py);

    const newHoveredMarginalia = marginaliaHit?.id || null;
    if (newHoveredMarginalia !== hoveredMarginaliaId) {
      hoveredMarginaliaId = newHoveredMarginalia;
    }

    const newHoveredLabel = labelFrame?.id || null;
    const newHoveredFrame = bodyFrame?.id || null;

    if (newHoveredLabel !== hoveredLabelFrameId) {
      hoveredLabelFrameId = newHoveredLabel;
    }

    if (newHoveredFrame !== hoveredFrameId) {
      const now = performance.now();
      if (hoveredFrameId) {
        const prev = frameHoverState[hoveredFrameId] || { level: 0 };
        frameHoverState[hoveredFrameId] = { direction: 'out', t0: now, startLevel: prev.level ?? 1 };
      }
      if (newHoveredFrame && newHoveredFrame !== focusedFrameId) {
        const prev = frameHoverState[newHoveredFrame] || { level: 0 };
        frameHoverState[newHoveredFrame] = { direction: 'in', t0: now, startLevel: prev.level ?? 0 };
      }
      hoveredFrameId = newHoveredFrame;
    }

    if (nodeIdx !== hoveredNodeIdx) {
      const now = performance.now();
      if (hoveredNodeIdx !== null) {
        lastHoveredNodeIdx = hoveredNodeIdx;
        nodeHoverLeaveT0 = now;
      }
      hoveredNodeIdx = nodeIdx;
      if (nodeIdx !== null) {
        nodeHoverT0 = now;
      }
    }

    const decHover = decisionNodeAtPoint(px, py);
    hoveredDecisionId = decHover ? decHover.id : null;

    const todoHover = todoNodeAtPoint(px, py);
    hoveredTodoId = todoHover ? todoHover.id : null;

    const aggHover = aggregateAtPoint(px, py);
    hoveredAggregateId = aggHover ? aggHover.id : null;

    if (decHover || todoHover || aggHover) {
      canvas.style.cursor = 'pointer';
    } else if (marginaliaHit) {
      canvas.style.cursor = 'pointer';
    } else if (nodeIdx !== null) {
      canvas.style.cursor = 'pointer';
    } else if (labelFrame) {
      canvas.style.cursor = 'pointer';
    } else if (focusedFrameId && !bodyFrame) {
      canvas.style.cursor = 'pointer';
    } else if (bodyFrame && bodyFrame.id !== focusedFrameId) {
      canvas.style.cursor = 'pointer';
    } else if (bodyFrame && bodyFrame.id === focusedFrameId) {
      canvas.style.cursor = 'default';
    } else {
      canvas.style.cursor = 'default';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (hoveredFrameId) {
      const prev = frameHoverState[hoveredFrameId] || { level: 0 };
      frameHoverState[hoveredFrameId] = { direction: 'out', t0: performance.now(), startLevel: prev.level ?? 1 };
    }
    if (hoveredNodeIdx !== null) {
      lastHoveredNodeIdx = hoveredNodeIdx;
      nodeHoverLeaveT0 = performance.now();
    }
    hoveredLabelFrameId = null;
    hoveredFrameId = null;
    hoveredNodeIdx = null;
    hoveredMarginaliaId = null;
    hoveredDecisionId = null;
    hoveredTodoId = null;
    hoveredAggregateId = null;
    canvas.style.cursor = 'default';
  });

  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const nodeIdx = nodeAtPoint(px, py);
    if (nodeIdx !== null) {
      const n = nodes[nodeIdx];
      anchorNodeIdx = nodeIdx;
      setFocus(n.frameId === focusedFrameId ? null : n.frameId);
      if (!focusedFrameId) anchorNodeIdx = null;
      return;
    }
    const frame = showFrames ? frameAtPoint(px, py) : null;
    if (frame) {
      anchorNodeIdx = null;
      setFocus(frame.id === focusedFrameId ? null : frame.id);
    }
  });

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (focusedRecord) {
      const marginaliaHit = marginaliaAtPoint(px, py);
      if (marginaliaHit) {
        const hitId = marginaliaHit.id;
        if (focusedRecord.type === marginaliaHit.type && String(focusedRecord.id) === hitId) {
          closeRecord();
        } else {
          openRecord(marginaliaHit.type, hitId);
        }
        return;
      }
      const decHit = decisionNodeAtPoint(px, py);
      if (decHit) {
        openRecord('decision', decHit.id);
        return;
      }
      const todoHit = todoNodeAtPoint(px, py);
      if (todoHit) {
        openRecord('todo', todoHit.id);
        return;
      }
      closeRecord();
      return;
    }

    const marginaliaHit = marginaliaAtPoint(px, py);
    if (marginaliaHit) {
      const hitId = marginaliaHit.id;
      openRecord(marginaliaHit.type, hitId);
      return;
    }

    const decHit = decisionNodeAtPoint(px, py);
    if (decHit) {
      openRecord('decision', decHit.id);
      return;
    }

    const todoHit = todoNodeAtPoint(px, py);
    if (todoHit) {
      openRecord('todo', todoHit.id);
      return;
    }

    const nodeIdx = nodeAtPoint(px, py);
    if (nodeIdx !== null) {
      const n = nodes[nodeIdx];
      if (pinnedNodeIdx === nodeIdx) {
        lastPinnedNodeIdx = pinnedNodeIdx;
        pinnedLeavingT0 = performance.now();
        pinnedNodeIdx = null;
      } else {
        if (pinnedNodeIdx !== null) {
          lastPinnedNodeIdx = pinnedNodeIdx;
          pinnedLeavingT0 = performance.now();
        }
        pinnedNodeIdx = nodeIdx;
        pinnedT0 = performance.now();
      }
      anchorNodeIdx = nodeIdx;
      if (n.frameId !== focusedFrameId) {
        setFocus(n.frameId);
      }
      return;
    }

    if (pinnedNodeIdx !== null) {
      lastPinnedNodeIdx = pinnedNodeIdx;
      pinnedLeavingT0 = performance.now();
      pinnedNodeIdx = null;
    }

    const labelFrame = showFrames ? frameLabelAtPoint(px, py) : null;
    if (labelFrame) {
      anchorNodeIdx = null;
      setFocus(labelFrame.id === focusedFrameId ? null : labelFrame.id);
      return;
    }

    if (focusedFrameId) {
      const bodyFrame = showFrames ? frameAtPoint(px, py) : null;
      if (!bodyFrame || bodyFrame.id !== focusedFrameId) {
        anchorNodeIdx = null;
        setFocus(null);
      }
    }
  });

  const decisionNodeRects = [];
  const todoNodeRects = [];
  const aggregateRects = [];
  const decisionExpandState = {};
  const DECISION_EXPAND_IN_MS = 160;
  const DECISION_EXPAND_OUT_MS = 200;

  function decisionExpandLevel(decId, target, now) {
    const s = decisionExpandState[decId] || { level: 0, direction: 'out', t0: 0 };
    const want = target ? 'in' : 'out';
    if (s.direction !== want) {
      s.startLevel = s.level;
      s.direction = want;
      s.t0 = now;
    }
    const dur = want === 'in' ? DECISION_EXPAND_IN_MS : DECISION_EXPAND_OUT_MS;
    const p = Math.min(1, (now - s.t0) / dur);
    const eased = ease(p);
    const targ = want === 'in' ? 1 : 0;
    const start = s.startLevel ?? s.level;
    s.level = start + (targ - start) * eased;
    decisionExpandState[decId] = s;
    return s.level;
  }

  function ambientDecisions() {
    return Object.values(DECISIONS).filter(d =>
      d.state === 'active' || d.state === 'proposed'
    );
  }

  function drawFloatingDecisionNodes(now) {
    decisionNodeRects.length = 0;
    const list = ambientDecisions();
    if (!list.length) return;

    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';

    const selectedDecId = (focusedRecord && focusedRecord.type === 'decision') ? focusedRecord.id : null;

    list.forEach(dec => {
      const governedFrameIds = new Set();
      dec.governs.forEach(g => {
        if (g.kind === 'frame') governedFrameIds.add(g.id);
        else if (g.kind === 'file') {
          const fid = frameIdForPath(FRAME_PATH_INDEX, g.path);
          if (fid) governedFrameIds.add(fid);
        }
      });

      const governedPositions = (dec._nodeIdxs || []).map(i => nodePx(nodes[i]));
      if (!governedPositions.length) return;

      let cx = governedPositions.reduce((s, p) => s + p.x, 0) / governedPositions.length;
      let cy = governedPositions.reduce((s, p) => s + p.y, 0) / governedPositions.length;

      let dotX = cx, dotY = cy;
      let tries = 0;
      const dotBoxR = 14;
      while (tries < 16) {
        let overlap = false;
        for (const frame of FRAMES) {
          if (governedFrameIds.has(frame.id)) continue;
          const f = framePx(frame);
          if (dotX + dotBoxR > f.cx - f.w / 2 - 6 && dotX - dotBoxR < f.cx + f.w / 2 + 6
             && dotY + dotBoxR > f.cy - f.h / 2 - 6 && dotY - dotBoxR < f.cy + f.h / 2 + 6) {
            overlap = true;
            const dx = dotX - f.cx;
            const dy = dotY - f.cy;
            const dist = Math.hypot(dx, dy) || 1;
            dotX += (dx / dist) * 16;
            dotY += (dy / dist) * 16;
          }
        }
        if (!overlap) break;
        tries++;
      }

      const state = dec.state;
      const dotColor =
        state === 'stale'      ? [160, 175, 165] :
        state === 'deprecated' ? [134, 239, 172] :
                                 [74, 222, 128];

      liveFx.recordDotPos(dec.id, dotX, dotY);

      const isSelected = selectedDecId === dec.id;
      // Hover via the floating dot OR this decision's marginalia pill — either
      // lights up the decision's leader edges (dot AND marginalia connections).
      const isHovered = hoveredDecisionId === dec.id || hoveredMarginaliaId === dec.id;
      const focusTouches = focusedFrameId && governedFrameIds.has(focusedFrameId);
      const pillVisible = isHovered || isSelected || focusTouches;
      const expand = decisionExpandLevel(dec.id, pillVisible, now);

      const DOT_R = 4;
      const HIT_R = 14;

      // Leader lines connecting the decision to what it governs. Hover HIGHLIGHTS
      // them (brighter + thicker); a selected decision keeps calmer persistent
      // leaders; a frame that merely touches it (focused, not hovered) shows faint
      // guide lines.
      // Update treatment: a fired connection boosts the leaders once, then settles.
      const fireBoost = liveFx.leaderBoost(dec.id, now);
      const leadersOn = isSelected || isHovered || fireBoost > 0;
      if (leadersOn) {
        const hl = isHovered || isSelected; // hover OR open drawer = highlight
        governedPositions.forEach(p => {
          const leadAlpha = hl ? 0.6 : Math.max(0.22, 0.3 + 0.4 * fireBoost);
          ctx.strokeStyle = `rgba(74, 222, 128, ${leadAlpha})`;
          ctx.lineWidth = hl ? 1.2 : 0.6;
          ctx.setLineDash(state === 'proposed' ? [2, 3] : [2, 2]);
          ctx.beginPath();
          ctx.moveTo(dotX, dotY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
        // Decision → child-TODO leaders (spawnsFrom). Only when both layers visible.
        if (showTodos) {
          for (const todoId of (SPAWNS_FROM[dec.id] || [])) {
            const childTodo = TODOS[todoId];
            for (const idx of (childTodo?._nodeIdxs || [])) {
              const p = nodePx(nodes[idx]);
              ctx.strokeStyle = `rgba(250, 204, 21, ${hl ? 0.6 : 0.30})`; // yellow, distinct from green governed leaders
              ctx.lineWidth = hl ? 1.2 : 0.6;
              ctx.setLineDash([2, 2]);
              ctx.beginPath();
              ctx.moveTo(dotX, dotY);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }
        }
      } else if (expand > 0.001) {
        governedPositions.forEach(p => {
          ctx.strokeStyle = `rgba(74, 222, 128, ${0.14 * expand})`;
          ctx.lineWidth = 0.6;
          ctx.setLineDash(state === 'proposed' ? [2, 3] : [2, 2]);
          ctx.beginPath();
          ctx.moveTo(dotX, dotY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }

      const birthT = liveFx.birth(dec.id, now);
      const dotFillAlpha = state === 'proposed' ? 0.42 : 0.95;
      if (birthT !== null) {
        // v5 added-node grammar: outline sketch → fill commits (fill lands late).
        const fillIn = ease(Math.min(1, Math.max(0, (birthT - 0.4) / 0.6)));
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, 0.9)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
        ctx.stroke();
        if (fillIn > 0) {
          ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${dotFillAlpha * fillIn})`;
          ctx.beginPath();
          ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${dotFillAlpha})`;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }

      // Update treatment: halo lifts then drains (no idle halo, no pulse).
      const lift = liveFx.haloLift(dec.id, now);
      if (lift > 0) {
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.26 * lift})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (state === 'deprecated') {
        ctx.strokeStyle = `rgba(245, 158, 11, 0.8)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (isSelected) {
        const selRingAlpha = state === 'proposed' ? 0.32 : 0.5;
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${selRingAlpha})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      let pillRect = null;
      if (expand > 0.001) {
        // Node label shows ONLY the sequenced id (e.g. "D-12"); the title lives
        // in the focused-frame marginalia, so repeating it on the node was redundant.
        const label = decisionDisplayId(dec);
        const labelW = ctx.measureText(label).width;
        const pillH = 22;
        const padX = 10;
        const pillW = padX + labelW + padX;

        const offset = DOT_R + 8;
        let pillX = dotX + offset;
        let pillY = dotY - pillH / 2;
        const stageW = canvas.clientWidth;
        const stageH = canvas.clientHeight;
        if (pillX + pillW > stageW - 8) {
          pillX = dotX - offset - pillW;
        }
        if (pillY + pillH > stageH - 8) pillY = stageH - 8 - pillH;
        if (pillY < 8) pillY = 8;

        const pillAlpha = expand;
        const stateFade = state === 'proposed' ? 0.65 : 1;

        ctx.fillStyle = `rgba(${pillBgGreenRGB()[0]}, ${pillBgGreenRGB()[1]}, ${pillBgGreenRGB()[2]}, ${0.96 * pillAlpha})`;
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.fill();

        const borderAlpha = (state === 'stale' ? 0.4 : 0.55) * stateFade;
        ctx.strokeStyle = `rgba(74, 222, 128, ${borderAlpha * pillAlpha})`;
        ctx.lineWidth = 1;
        if (state === 'proposed') ctx.setLineDash([3, 2.5]);
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = `rgba(${decisionTextRGB()[0]}, ${decisionTextRGB()[1]}, ${decisionTextRGB()[2]}, ${0.98 * pillAlpha * stateFade})`;
        ctx.textAlign = 'left';
        ctx.fillText(label, pillX + padX, pillY + pillH / 2);

        pillRect = { x: pillX, y: pillY, w: pillW, h: pillH };
      }

      decisionNodeRects.push({
        id: dec.id,
        x: dotX - HIT_R, y: dotY - HIT_R, w: HIT_R * 2, h: HIT_R * 2,
        pillRect,
        cx: dotX, cy: dotY,
      });
    });

    ctx.restore();
  }

  function decisionNodeAtPoint(px, py) {
    for (const r of decisionNodeRects) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
      if (r.pillRect) {
        const p = r.pillRect;
        if (px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h) return r;
      }
    }
    return null;
  }

  function drawFloatingTodoNodes(now) {
    todoNodeRects.length = 0;
    const list = Object.values(TODOS); // already ambient-filtered (done/cancelled excluded)
    if (!list.length) return;

    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';

    const selectedTodoId = (focusedRecord && focusedRecord.type === 'todo') ? focusedRecord.id : null;

    list.forEach(todo => {
      const governedPositions = (todo._nodeIdxs || []).map(i => nodePx(nodes[i]));
      // Standalone TODOs with no governed frame → no _nodeIdxs → skip (known limitation).
      if (!governedPositions.length) return;

      // Governed frame ids for overlap-repulsion logic.
      const governedFrameIds = new Set();
      (todo.governs || []).forEach(g => {
        if (g.kind === 'frame') governedFrameIds.add(g.id);
        else if (g.kind === 'file') {
          const fid = frameIdForPath(FRAME_PATH_INDEX, g.path);
          if (fid) governedFrameIds.add(fid);
        }
      });

      let cx = governedPositions.reduce((s, p) => s + p.x, 0) / governedPositions.length;
      let cy = governedPositions.reduce((s, p) => s + p.y, 0) / governedPositions.length;

      let dotX = cx, dotY = cy;
      let tries = 0;
      const dotBoxR = 14;
      while (tries < 16) {
        let overlap = false;
        for (const frame of FRAMES) {
          if (governedFrameIds.has(frame.id)) continue;
          const f = framePx(frame);
          if (dotX + dotBoxR > f.cx - f.w / 2 - 6 && dotX - dotBoxR < f.cx + f.w / 2 + 6
             && dotY + dotBoxR > f.cy - f.h / 2 - 6 && dotY - dotBoxR < f.cy + f.h / 2 + 6) {
            overlap = true;
            const dx = dotX - f.cx;
            const dy = dotY - f.cy;
            const dist = Math.hypot(dx, dy) || 1;
            dotX += (dx / dist) * 16;
            dotY += (dy / dist) * 16;
          }
        }
        if (!overlap) break;
        tries++;
      }

      const { rgb, ring } = todoDotColor(todo.state);
      // in_progress: no per-assignee identity color in this viewer → yellow base (rgb).

      const isSelected = selectedTodoId === todo.id;
      // Hover via the floating dot OR this todo's marginalia pill.
      const isHovered = hoveredTodoId === todo.id || hoveredMarginaliaId === todo.id;
      const pillVisible = isHovered || isSelected;

      const DOT_R = 4;
      const HIT_R = 14;

      liveFx.recordDotPos(todo.id, dotX, dotY);

      // Leader lines: hover HIGHLIGHTS the todo's connections (brighter +
      // thicker); a selected todo keeps calmer persistent leaders; an applied
      // update fires them once then settles.
      const fireBoost = liveFx.leaderBoost(todo.id, now);
      if (isSelected || isHovered || fireBoost > 0) {
        const hl = isHovered || isSelected; // hover OR open drawer = highlight
        governedPositions.forEach(p => {
          const leadAlpha = hl ? 0.6 : Math.max(0.22, 0.3 + 0.4 * fireBoost);
          ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${leadAlpha})`;
          ctx.lineWidth = hl ? 1.2 : 0.6;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(dotX, dotY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }

      // Dot fill — birth-aware (outline sketch → fill commits) on create.
      const birthT = liveFx.birth(todo.id, now);
      if (birthT !== null) {
        const fillIn = ease(Math.min(1, Math.max(0, (birthT - 0.4) / 0.6)));
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.9)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
        ctx.stroke();
        if (fillIn > 0) {
          ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.95 * fillIn})`;
          ctx.beginPath();
          ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.95)`;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }

      // Update treatment: halo lifts then drains (no idle halo, no pulse).
      const lift = liveFx.haloLift(todo.id, now);
      if (lift > 0) {
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.26 * lift})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Amber ring for blocked state.
      if (ring) {
        ctx.strokeStyle = `rgba(${ring[0]}, ${ring[1]}, ${ring[2]}, 0.8)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Selection ring.
      if (isSelected) {
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.5)`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Node label: just the sequenced id "T-NNN" (title lives in the marginalia).
      let pillRect = null;
      if (pillVisible) {
        const label = todoDisplayId(todo);
        const labelW = ctx.measureText(label).width;
        const pillH = 22;
        const padX = 10;
        const pillW = padX + labelW + padX;

        const offset = DOT_R + 8;
        let pillX = dotX + offset;
        let pillY = dotY - pillH / 2;
        const stageW = canvas.clientWidth;
        const stageH = canvas.clientHeight;
        if (pillX + pillW > stageW - 8) {
          pillX = dotX - offset - pillW;
        }
        if (pillY + pillH > stageH - 8) pillY = stageH - 8 - pillH;
        if (pillY < 8) pillY = 8;

        // Pill bg: neutral (no yellow tint).
        ctx.fillStyle = `rgba(${pillBgRGB()[0]}, ${pillBgRGB()[1]}, ${pillBgRGB()[2]}, 0.96)`;
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.fill();

        // Pill border: yellow.
        ctx.strokeStyle = `rgba(${todoDotRGB()[0]}, ${todoDotRGB()[1]}, ${todoDotRGB()[2]}, 0.55)`;
        ctx.lineWidth = 1;
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.stroke();

        // Label (T-NNN) in yellow.
        ctx.fillStyle = `rgba(${todoTextRGB()[0]}, ${todoTextRGB()[1]}, ${todoTextRGB()[2]}, 0.98)`;
        ctx.textAlign = 'left';
        ctx.fillText(label, pillX + padX, pillY + pillH / 2);

        pillRect = { x: pillX, y: pillY, w: pillW, h: pillH };
      }

      todoNodeRects.push({
        id: todo.id,
        x: dotX - HIT_R, y: dotY - HIT_R, w: HIT_R * 2, h: HIT_R * 2,
        pillRect,
        cx: dotX, cy: dotY,
      });
    });

    ctx.restore();
  }

  function todoNodeAtPoint(px, py) {
    for (const r of todoNodeRects) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
      if (r.pillRect) {
        const p = r.pillRect;
        if (px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h) return r;
      }
    }
    return null;
  }

  function drawFrames(now) {
    marginaliaRects.length = 0;
    const fp = computeFocusProgress();
    const hasFocus = !!(fp.focused || (fp.from && fp.t < 1));
    const sharpFrameId = fp.focused;

    FRAMES.forEach(frame => {
      const f = framePx(frame);
      const isFocused = frame.id === sharpFrameId;
      // Satellite (non-ambient) frames are drawn at half prominence so they
      // don't compete visually with the ambient frames that anchor the layout.
      const alphaMul = frame.deemphasized ? 0.5 : 1;

      let dimLevel = 0;
      if (hasFocus && !isFocused) {
        dimLevel = fp.focused ? fp.t : (1 - fp.t);
      }

      let hoverLevel = 0;
      const hv = frameHoverState[frame.id];
      if (hv && !isFocused) {
        const elapsed = performance.now() - hv.t0;
        if (hv.direction === 'in') {
          const p = Math.min(1, elapsed / HOVER_IN_MS);
          const eased = ease(p);
          hoverLevel = hv.startLevel + (1 - hv.startLevel) * eased;
          hv.level = hoverLevel;
        } else {
          const p = Math.min(1, elapsed / HOVER_OUT_MS);
          const eased = ease(p);
          hoverLevel = hv.startLevel * (1 - eased);
          hv.level = hoverLevel;
          if (p >= 1) delete frameHoverState[frame.id];
        }
      }

      ctx.save();
      ctx.translate(f.cx, f.cy);

      if (showFrames) {
        const lc = layersOn && frame.layer ? LAYER_RGB[frame.layer] : null;

        const baseFillAlpha = 0.25 * (1 - dimLevel * 0.4);
        const fillAlpha = (baseFillAlpha + hoverLevel * 0.18) * alphaMul;
        const ff = frameFillRGB();
        const fillAlphaActual = isLight() ? fillAlpha * 0.45 : fillAlpha;
        if (lc) {
          // Layer tint: hue at the spec's quiet alpha, scaled by the same dim/hover factors.
          ctx.fillStyle = `rgba(${lc[0]}, ${lc[1]}, ${lc[2]}, ${0.032 * (fillAlphaActual / (isLight() ? 0.25 * 0.45 : 0.25))})`;
        } else {
          ctx.fillStyle = `rgba(${ff[0]}, ${ff[1]}, ${ff[2]}, ${fillAlphaActual})`;
        }
        ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);

        const baseBorderAlpha = 0.08 + 0.15 * liveFx.frameHeat(frame.id, now);
        const focusBoost = isFocused ? 0.12 : 0;
        const hoverBorderBoost = hoverLevel * 0.2;
        const borderAlphaMult = isLight() ? 3.0 : 1;
        const borderAlpha = (baseBorderAlpha + focusBoost + hoverBorderBoost) * (1 - dimLevel * 0.5) * borderAlphaMult * alphaMul;

        const fb = frameBorderRGB();
        if (lc) {
          ctx.strokeStyle = `rgba(${lc[0]}, ${lc[1]}, ${lc[2]}, ${0.22 * (borderAlpha / (0.08 * borderAlphaMult))})`;
        } else {
          ctx.strokeStyle = `rgba(${fb[0]}, ${fb[1]}, ${fb[2]}, ${borderAlpha})`;
        }
        ctx.lineWidth = isFocused ? 1.2 : 1;
        roundedRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h, 4);
        ctx.stroke();

        const isLabelHovered = hoveredLabelFrameId === frame.id;
        const labelAlpha = 0.5 * (1 - dimLevel * 0.55) * alphaMul;
        const hoverBoost = isLabelHovered ? (1 - labelAlpha) * 0.85 : 0;
        const labelAlphaFinal = Math.min(1, labelAlpha + hoverBoost);
        const primaryY = -f.h / 2 - 7;

        ctx.textBaseline = 'alphabetic';
        const gap = 8;

        ctx.font = '10px "Geist Mono", monospace';
        ctx.textAlign = 'right';
        const countText = String(frame.count);
        const countW = ctx.measureText(countText).width;
        if (isLabelHovered) {
          const pl = primaryLabelRGB();
          ctx.fillStyle = `rgba(${pl[0]}, ${pl[1]}, ${pl[2]}, ${0.95 * alphaMul})`;
        } else {
          const ci = countIdleRGB();
          ctx.fillStyle = `rgba(${ci[0]}, ${ci[1]}, ${ci[2]}, ${0.85 * (1 - dimLevel * 0.55) * alphaMul})`;
        }
        ctx.fillText(countText, f.w / 2, primaryY);

        ctx.font = '500 10px "Geist Mono", monospace';
        ctx.textAlign = 'left';
        const leftBudget = f.w - countW - gap;
        const pathText = truncateMiddle(ctx, frame.name, leftBudget);
        const pl = primaryLabelRGB();
        if (lc) {
          ctx.fillStyle = `rgba(${lc[0]}, ${lc[1]}, ${lc[2]}, ${Math.min(1, 0.55 * (labelAlphaFinal / 0.5))})`;
        } else {
          ctx.fillStyle = `rgba(${pl[0]}, ${pl[1]}, ${pl[2]}, ${labelAlphaFinal})`;
        }
        ctx.fillText(pathText, -f.w / 2, primaryY);
      }

      ctx.restore();
    });

    if (showDecisions || showTodos) {
      if (sharpFrameId) {
        drawMarginaliaForFrame(sharpFrameId, fp.t);
      } else if (fp.from) {
        drawMarginaliaForFrame(fp.from, 1 - fp.t);
      }
    }
  }

  const marginaliaRects = [];

  function drawMarginaliaForFrame(frameId, alphaMult) {
    // Invisible pills must not register hit rects — anything drawn here is
    // hoverable/clickable via marginaliaRects, so skip the fully-faded state.
    if (alphaMult <= 0.01) return;
    const frame = FRAMES.find(f => f.id === frameId);
    if (!frame) return;
    const decs = getFrameDecisions(frameId);
    const todos = getFrameTodos(frameId);
    if (!decs.length && !todos.length) return;

    // The record whose drawer is currently open — its edges stay lit, like hover.
    const openDecId = (focusedRecord && focusedRecord.type === 'decision') ? focusedRecord.id : null;
    const openTodoId = (focusedRecord && focusedRecord.type === 'todo') ? focusedRecord.id : null;

    const f = framePx(frame);
    const pillX = f.cx + f.w / 2 + 14;
    let pillY = f.cy - f.h / 2 + 4;

    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';

    if (showDecisions) decs.forEach((dec) => {
      const state = dec.state || 'active';
      const label = `${decisionDisplayId(dec)} · ${dec.summary}`;
      const labelW = ctx.measureText(label).width;
      const pillH = 20;
      const padX = 10;
      const markSize = 5;
      const markGap = 7;
      const pillW = padX + markSize + markGap + labelW + padX;

      const desaturated = state === 'superseded' || state === 'stale';
      const stateAlpha = state === 'superseded' ? 0.55 : (state === 'stale' ? 0.7 : 1);
      const dotColor = desaturated ? [140, 160, 150] : [74, 222, 128];
      const leaderColor =
        state === 'superseded' ? [120, 120, 125] :
        state === 'stale'      ? [180, 140, 90]  :
        state === 'deprecated' ? [245, 158, 11]  :
                                 [74, 222, 128];
      const leaderAlpha = state === 'superseded' ? 0.1 : 0.2;
      const borderColor =
        state === 'superseded' ? [120, 140, 130] :
        state === 'stale'      ? [140, 160, 145] :
                                 [74, 222, 128];
      const borderAlpha = state === 'superseded' ? 0.3 : (state === 'stale' ? 0.4 : 0.55);

      // Lit when hovered (via this pill OR the floating dot) OR when this
      // decision's drawer is open — keeps the marginalia leader edges highlighted.
      const isHovered = hoveredMarginaliaId === dec.id || hoveredDecisionId === dec.id || openDecId === dec.id;

      const nodeIdxs = dec._nodeIdxs || [];
      nodeIdxs.forEach(idx => {
        const p = nodePx(nodes[idx]);
        ctx.strokeStyle = `rgba(${leaderColor[0]}, ${leaderColor[1]}, ${leaderColor[2]}, ${(isHovered ? 0.6 : leaderAlpha) * alphaMult})`;
        ctx.lineWidth = isHovered ? 1.2 : 0.6;
        ctx.setLineDash(state === 'proposed' ? [2, 3] : [2, 2]);
        ctx.beginPath();
        ctx.moveTo(pillX, pillY + pillH / 2);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
      });
      const bgAlpha = (isHovered ? 1 : 0.85) * alphaMult * stateAlpha;
      const mpBg = pillBgGreenRGB();
      ctx.fillStyle = `rgba(${mpBg[0]}, ${mpBg[1]}, ${mpBg[2]}, ${bgAlpha})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(${borderColor[0]}, ${borderColor[1]}, ${borderColor[2]}, ${(borderAlpha + (isHovered ? 0.2 : 0)) * alphaMult})`;
      ctx.lineWidth = 1;
      if (state === 'proposed') ctx.setLineDash([3, 2.5]);
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (state === 'stale') {
        ctx.fillStyle = `rgba(245, 158, 11, ${0.9 * alphaMult})`;
        ctx.fillRect(pillX + 1, pillY + 4, 2, pillH - 8);
      }

      const markCx = pillX + padX + markSize / 2;
      const markCy = pillY + pillH / 2;
      if (state === 'proposed') {
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.9 * alphaMult})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(markCx, markCy, markSize / 2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.9 * alphaMult * stateAlpha})`;
        ctx.beginPath();
        ctx.arc(markCx, markCy, markSize / 2, 0, Math.PI * 2);
        ctx.fill();

        if (state === 'deprecated') {
          ctx.strokeStyle = `rgba(245, 158, 11, ${0.85 * alphaMult})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(markCx, markCy, markSize / 2 + 2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      const textAlpha = state === 'superseded' ? 0.6 : (state === 'proposed' || state === 'stale' ? 0.8 : 0.95);
      const mpText = pillTextRGB();
      ctx.fillStyle = `rgba(${mpText[0]}, ${mpText[1]}, ${mpText[2]}, ${textAlpha * alphaMult})`;
      ctx.textAlign = 'left';
      ctx.fillText(label, pillX + padX + markSize + markGap, pillY + pillH / 2);

      if (state === 'superseded') {
        ctx.strokeStyle = `rgba(${mpText[0]}, ${mpText[1]}, ${mpText[2]}, ${0.25 * alphaMult})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(pillX + 6, pillY + pillH / 2);
        ctx.lineTo(pillX + pillW - 6, pillY + pillH / 2);
        ctx.stroke();
      }

      marginaliaRects.push({
        type: 'decision',
        id: dec.id,
        x: pillX, y: pillY, w: pillW, h: pillH,
        frameId,
      });

      pillY += pillH + 8;
    });

    if (showTodos) todos.forEach((todo) => {
      const { rgb, ring } = todoDotColor(todo.state);
      const leaderColor = [250, 204, 21];
      const leaderAlpha = 0.2;

      const label = `${todoDisplayId(todo)} · ${todo.summary}`;
      const labelW = ctx.measureText(label).width;
      const pillH = 20;
      const padX = 10;
      const markSize = 5;
      const markGap = 7;
      const pillW = padX + markSize + markGap + labelW + padX;

      // Lit when hovered (via this pill OR the floating dot) OR when this todo's
      // drawer is open — keeps the marginalia leader edges highlighted.
      const isHovered = hoveredMarginaliaId === todo.id || hoveredTodoId === todo.id || openTodoId === todo.id;

      // Leader lines to anchor node dots — highlighted on hover.
      const nodeIdxs = todo._nodeIdxs || [];
      nodeIdxs.forEach(idx => {
        const p = nodePx(nodes[idx]);
        ctx.strokeStyle = `rgba(${leaderColor[0]}, ${leaderColor[1]}, ${leaderColor[2]}, ${(isHovered ? 0.6 : leaderAlpha) * alphaMult})`;
        ctx.lineWidth = isHovered ? 1.2 : 0.6;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(pillX, pillY + pillH / 2);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      // Pill bg: neutral.
      const bgAlpha = (isHovered ? 1 : 0.85) * alphaMult;
      const mpBg = pillBgRGB();
      ctx.fillStyle = `rgba(${mpBg[0]}, ${mpBg[1]}, ${mpBg[2]}, ${bgAlpha})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();

      // Pill border: yellow.
      const borderAlpha = 0.55;
      ctx.strokeStyle = `rgba(${leaderColor[0]}, ${leaderColor[1]}, ${leaderColor[2]}, ${(borderAlpha + (isHovered ? 0.2 : 0)) * alphaMult})`;
      ctx.lineWidth = 1;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.stroke();

      // Blocked state: amber left-tick.
      if (ring) {
        ctx.fillStyle = `rgba(${ring[0]}, ${ring[1]}, ${ring[2]}, ${0.9 * alphaMult})`;
        ctx.fillRect(pillX + 1, pillY + 4, 2, pillH - 8);
      }

      // Mark dot: color from todoDotColor rgb.
      const markCx = pillX + padX + markSize / 2;
      const markCy = pillY + pillH / 2;
      ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.9 * alphaMult})`;
      ctx.beginPath();
      ctx.arc(markCx, markCy, markSize / 2, 0, Math.PI * 2);
      ctx.fill();

      // Amber ring on mark for blocked state.
      if (ring) {
        ctx.strokeStyle = `rgba(${ring[0]}, ${ring[1]}, ${ring[2]}, ${0.85 * alphaMult})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(markCx, markCy, markSize / 2 + 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Label text.
      const mpText = pillTextRGB();
      ctx.fillStyle = `rgba(${mpText[0]}, ${mpText[1]}, ${mpText[2]}, ${0.95 * alphaMult})`;
      ctx.textAlign = 'left';
      ctx.fillText(label, pillX + padX + markSize + markGap, pillY + pillH / 2);

      marginaliaRects.push({
        type: 'todo',
        id: todo.id,
        x: pillX, y: pillY, w: pillW, h: pillH,
        frameId,
      });

      pillY += pillH + 8;
    });

    ctx.restore();
  }

  function drawEdges() {
    // Compute the max weight once so we can scale opacity. Falls back to 1
    // when all edges have unit weight (or none).
    let maxW = 1;
    for (const e of edges) {
      if (e.weight && e.weight > maxW) maxW = e.weight;
    }
    edges.forEach((e) => {
      const a = nodePx(nodes[e.a]);
      const b = nodePx(nodes[e.b]);
      // Inter-frame edges read at lower base alpha so they don't drown out
      // the local connectivity inside each frame. Then scale by sqrt(weight)
      // so a heavy CALLS relationship reads visibly heavier than a single
      // shared method.
      const baseAlpha = e.interFrame ? 0.09 : 0.15;
      const wScale = e.weight ? 0.4 + 0.6 * Math.sqrt(e.weight / maxW) : 1;
      const alpha = baseAlpha * wScale * (isLight() ? 2.2 : 1);

      ctx.save();
      const eb = frameBorderRGB();
      ctx.strokeStyle = `rgba(${eb[0]}, ${eb[1]}, ${eb[2]}, ${alpha})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    });
  }

  function findGoverningDecision(nodeIdx) {
    const n = nodes[nodeIdx];
    const decs = getFrameDecisions(n.frameId);
    for (const dec of decs) {
      if ((dec._nodeIdxs || []).includes(nodeIdx)) return dec;
    }
    return null;
  }

  function findRecentToucher(nodeIdx) {
    return null;
  }

  function drawCompactHoverBadge(now) {
    if (pinnedNodeIdx === null) return;
    if (hoveredNodeIdx === null) return;
    if (hoveredNodeIdx === pinnedNodeIdx) return;

    const elapsed = now - nodeHoverT0;
    if (elapsed <= NODE_HOVER_DELAY) return;
    const p0 = Math.min(1, (elapsed - NODE_HOVER_DELAY) / NODE_HOVER_IN_MS);
    const alpha = ease(p0);
    if (alpha <= 0) return;

    const n = nodes[hoveredNodeIdx];
    const frame = FRAMES.find(f => f.id === n.frameId);
    const inFocused = focusedFrameId && frame?.id === focusedFrameId;
    const fp = computeFocusProgress();
    const sizeMult = inFocused ? 1 + 0.4 * fp.t : 1;
    const baseR = n.kind === 'decision' ? 2.8 : 2.2;
    const nodeR = baseR * sizeMult;

    const p = nodePx(n);

    ctx.save();
    ctx.font = '500 10.5px "Geist Mono", monospace';
    const label = n.name;
    const textW = ctx.measureText(label).width;
    const padX = 9;
    const padY = 5;
    const badgeH = 18;
    const badgeW = textW + padX * 2;

    const gap = 8;
    let badgeX = p.x + nodeR + gap;
    let badgeY = p.y - badgeH / 2;
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    if (badgeX + badgeW > stageW - 8) badgeX = p.x - nodeR - gap - badgeW;
    if (badgeY < 8) badgeY = 8;
    if (badgeY + badgeH > stageH - 8) badgeY = stageH - 8 - badgeH;

    const hpBg = hoverPillBgRGB();
    const hpText = hoverPillTextPrimaryRGB();
    ctx.fillStyle = `rgba(${hpBg[0]}, ${hpBg[1]}, ${hpBg[2]}, ${0.97 * alpha})`;
    roundedRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
    ctx.fill();

    ctx.fillStyle = `rgba(${hpText[0]}, ${hpText[1]}, ${hpText[2]}, ${0.95 * alpha})`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, badgeX + padX, badgeY + badgeH / 2);
    ctx.restore();
  }

  /**
   * Render a hover/info pill of text `lines` near anchor (anchorX, anchorY) — the
   * shared chrome behind every hover tooltip (file/decision/todo nodes AND
   * aggregates), so they all look identical. Offsets +14/+14 from the anchor and
   * flips to stay on-canvas. `lines`: [{ text, color, size, weight }].
   */
  function renderInfoPill(lines, anchorX, anchorY, alpha, pinned) {
    const padX = 11, padY = 9, lineGap = 4;
    let maxW = 0;
    lines.forEach(l => {
      ctx.font = `${l.weight} ${l.size}px 'Geist Mono', monospace`;
      const w = ctx.measureText(l.text).width;
      if (w > maxW) maxW = w;
    });
    const lineHeights = lines.map(l => l.size + 2);
    const totalLineH = lineHeights.reduce((a, b) => a + b, 0) + (lines.length - 1) * lineGap;
    const pillW = maxW + padX * 2;
    const pillH = totalLineH + padY * 2;

    let pillX = anchorX + 14;
    let pillY = anchorY + 14;
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    if (pillX + pillW > stageW - 8) pillX = anchorX - pillW - 14;
    if (pillY + pillH > stageH - 8) pillY = anchorY - pillH - 14;
    if (pillX < 8) pillX = 8;
    if (pillY < 8) pillY = 8;

    ctx.save();
    const hpbg = hoverPillBgRGB();
    if (pinned) {
      ctx.save();
      ctx.shadowColor = `rgba(0, 0, 0, ${(isLight() ? 0.18 : 0.28) * alpha})`;
      ctx.shadowBlur = isLight() ? 10 : 6;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = `rgba(${hpbg[0]}, ${hpbg[1]}, ${hpbg[2]}, ${0.97 * alpha})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, 6);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = `rgba(${hpbg[0]}, ${hpbg[1]}, ${hpbg[2]}, ${0.97 * alpha})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, 6);
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let y = pillY + padY;
    lines.forEach((l, i) => {
      ctx.font = `${l.weight} ${l.size}px 'Geist Mono', monospace`;
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, pillX + padX, y);
      y += lineHeights[i] + lineGap;
    });
    ctx.restore();
  }

  function drawHoverPill(now) {
    let pillNodeIdx = null;
    let pillAlpha = 0;

    if (pinnedNodeIdx !== null) {
      const elapsed = now - pinnedT0;
      const p0 = Math.min(1, elapsed / PIN_IN_MS);
      pillAlpha = ease(p0);
      pillNodeIdx = pinnedNodeIdx;
    } else if (lastPinnedNodeIdx !== null && pinnedLeavingT0 > 0 && (now - pinnedLeavingT0) < PIN_OUT_MS) {
      const elapsed = now - pinnedLeavingT0;
      const p0 = elapsed / PIN_OUT_MS;
      pillAlpha = 1 - ease(p0);
      pillNodeIdx = lastPinnedNodeIdx;
    } else if (hoveredNodeIdx !== null) {
      const elapsed = now - nodeHoverT0;
      if (elapsed > NODE_HOVER_DELAY) {
        const p0 = Math.min(1, (elapsed - NODE_HOVER_DELAY) / NODE_HOVER_IN_MS);
        pillAlpha = ease(p0);
        pillNodeIdx = hoveredNodeIdx;
      }
    } else if (lastHoveredNodeIdx !== null && nodeHoverLeaveT0 > 0) {
      const elapsed = now - nodeHoverLeaveT0;
      if (elapsed < NODE_HOVER_OUT_MS) {
        const p0 = elapsed / NODE_HOVER_OUT_MS;
        pillAlpha = 1 - ease(p0);
        pillNodeIdx = lastHoveredNodeIdx;
      }
    }

    if (pillNodeIdx === null || pillAlpha <= 0) return;

    const n = nodes[pillNodeIdx];
    const frame = FRAMES.find(f => f.id === n.frameId);
    const p = nodePx(n);

    const TEXT_RGB = hoverPillTextPrimaryRGB();
    const SUB_RGB  = hoverPillTextSecondaryRGB();

    const lines = [];
    lines.push({
      text: n.name,
      color: `rgba(${TEXT_RGB[0]}, ${TEXT_RGB[1]}, ${TEXT_RGB[2]}, ${0.95 * pillAlpha})`,
      size: 11, weight: 500,
    });

    const kindLabel = n.kind === 'decision'
      ? 'decision'
      : 'file · ' + (frame?.name ?? '');
    lines.push({
      text: kindLabel,
      color: `rgba(${SUB_RGB[0]}, ${SUB_RGB[1]}, ${SUB_RGB[2]}, ${0.95 * pillAlpha})`,
      size: 10, weight: 400,
    });

    const gov = findGoverningDecision(pillNodeIdx);
    if (gov) {
      const govTextRgb = isLight() ? [134, 239, 172] : [22, 101, 52];
      lines.push({
        text: `under ${gov.id} · ${gov.summary}`,
        color: `rgba(${govTextRgb[0]}, ${govTextRgb[1]}, ${govTextRgb[2]}, ${0.95 * pillAlpha})`,
        size: 10, weight: 500,
      });
    }

    renderInfoPill(lines, p.x, p.y, pillAlpha, pinnedNodeIdx === pillNodeIdx);
  }

  function drawNodes(now) {
    const fp = computeFocusProgress();
    const focusedId = fp.focused;

    nodes.forEach((n, i) => {
      const p = nodePx(n);
      const frame = FRAMES.find(f => f.id === n.frameId);
      const inFocused = focusedId && frame?.id === focusedId;
      const sizeMult = inFocused ? 1 + 0.4 * fp.t : (fp.from && frame?.id === fp.from ? 1 + 0.4 * (1 - fp.t) : 1);
      const isAnchor = anchorNodeIdx === i && inFocused;
      const isHovered = hoveredNodeIdx === i;

      ctx.save();
      if (n.kind === 'decision') {
        ctx.fillStyle = 'rgba(74, 222, 128, 0.85)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.8 * sizeMult, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const nb = nodeBaseRGB();
        ctx.fillStyle = `rgba(${nb[0]}, ${nb[1]}, ${nb[2]}, 0.75)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.9 * sizeMult, 0, Math.PI * 2);
        ctx.fill();
      }

      if (isAnchor) {
        const pulse = 0.7 + 0.3 * Math.sin(now * 0.003);
        const ab = frameBorderRGB();
        ctx.strokeStyle = `rgba(${ab[0]}, ${ab[1]}, ${ab[2]}, ${0.45 * pulse})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 * sizeMult, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (isHovered) {
        const elapsed = now - nodeHoverT0;
        const p0 = Math.min(1, Math.max(0, elapsed / NODE_HOVER_IN_MS));
        const ringAlpha = 0.55 * ease(p0);
        const hb = frameBorderRGB();
        ctx.strokeStyle = `rgba(${hb[0]}, ${hb[1]}, ${hb[2]}, ${ringAlpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const baseR = n.kind === 'decision' ? 2.8 : 2.2;
        ctx.arc(p.x, p.y, baseR * sizeMult + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    });
  }

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function truncateMiddle(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ell = '…';
    for (let keep = text.length - 1; keep >= 2; keep--) {
      const leftLen = Math.ceil(keep / 2);
      const rightLen = keep - leftLen;
      const candidate = text.slice(0, leftLen) + ell + text.slice(text.length - rightLen);
      if (ctx.measureText(candidate).width <= maxWidth) return candidate;
    }
    return ell;
  }

  /**
   * Draw auxiliary aggregates as bare dots; the title + file count are exposed
   * only on hover, via the SAME hover pill the other node dots use.
   */
  function drawAggregates(now) {
    aggregateRects.length = 0;
    if (!AGGREGATES || AGGREGATES.length === 0) return;
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const v = viewTransform;
    let hovered = null; // {agg, cx, cy} of the hovered dot → pill drawn after the loop, on top

    ctx.save();
    for (let i = 0; i < AGGREGATES.length; i++) {
      const agg = AGGREGATES[i];
      // Uniform dot size — aggregates are not sized by member_count.
      const dotR = AGG_DOT_R * v.scale;
      const { nx, ny } = aggregateFraction(agg, i, AGGREGATES.length);
      // Same fit-to-content transform as frames so dots stay anchored to the cloud.
      // Aggregates don't drive the fit (computeViewTransform frames the cloud
      // only), so a dot the keep-out flung far out could map off-canvas — clamp
      // it back on-screen so it stays visible.
      const cx = Math.max(dotR + 4, Math.min(stageW - dotR - 4, (nx * stageW) * v.scale + v.ox));
      const cy = Math.max(dotR + 4, Math.min(stageH - dotR - 4, (ny * stageH) * v.scale + v.oy));

      const isHovered = hoveredAggregateId === agg.id;
      const baseRgb = nodeBaseRGB();
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      // Idle dots sit quiet; the hovered dot brightens (like the other node dots).
      ctx.fillStyle = `rgba(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]},${isHovered ? 0.9 : 0.55})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]},${isHovered ? 1 : 0.9})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (isHovered) hovered = { agg, cx, cy };

      // Hit area for hover (a little larger than the dot so the small target is
      // easy to land on).
      const hitR = dotR + 4;
      aggregateRects.push({ id: agg.id, x: cx - hitR, y: cy - hitR, w: hitR * 2, h: hitR * 2 });
    }
    ctx.restore();

    // Hover tooltip — identical chrome to the file/decision/todo node pills.
    if (hovered) {
      const TEXT = hoverPillTextPrimaryRGB();
      const SUB = hoverPillTextSecondaryRGB();
      const n = hovered.agg.member_count;
      const lines = [
        { text: hovered.agg.label, color: `rgba(${TEXT[0]},${TEXT[1]},${TEXT[2]},0.95)`, size: 11, weight: 500 },
        { text: `aux · ${n} ${n === 1 ? 'file' : 'files'}`, color: `rgba(${SUB[0]},${SUB[1]},${SUB[2]},0.95)`, size: 10, weight: 400 },
      ];
      renderInfoPill(lines, hovered.cx, hovered.cy, 1, false);
    }
  }

  function aggregateAtPoint(px, py) {
    for (const r of aggregateRects) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
    }
    return null;
  }

  function drawLiveEffects(now) {
    // Removal: fill drains back to outline, then the sketch fades (reverse of birth).
    for (const tb of liveFx.tombstones(now)) {
      if (tb.x === null || tb.y === null) continue;
      const rgb = tb.entity === 'todo' ? todoDotRGB() : decisionDotRGB();
      const fade = 1 - ease(tb.t);
      ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.9 * fade})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(tb.x, tb.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      const fillFade = Math.max(0, 1 - tb.t * 2); // fill drains in the first half
      if (fillFade > 0) {
        ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.95 * fillFade})`;
        ctx.beginPath();
        ctx.arc(tb.x, tb.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Presence pills — v5 cursor-pill: vertically centered on the node, 11px
    // right of center; agent = colored fill + ✳ glyph, user = base-white @name.
    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';
    for (const p of liveFx.pills(now)) {
      if (p.x === null || p.y === null) continue;
      const label = p.name;
      const glyph = p.isUser ? '' : '✳ ';
      const text = glyph + label;
      const padX = 8;
      const pillH = 18;
      const pillW = padX + ctx.measureText(text).width + padX;
      let pillX = p.x + 11;
      if (pillX + pillW > canvas.clientWidth - 8) pillX = p.x - 11 - pillW; // edge flip
      const pillY = p.y - pillH / 2;
      const fill = p.isUser
        ? (isLight() ? [24, 24, 27] : [237, 237, 237])
        : [96, 165, 250]; // agent blue (v5 --agent-b)
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = `rgb(${fill[0]}, ${fill[1]}, ${fill[2]})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();
      const content = p.isUser ? (isLight() ? [250, 250, 250] : [15, 15, 15]) : [15, 15, 15];
      ctx.fillStyle = `rgb(${content[0]}, ${content[1]}, ${content[2]})`;
      ctx.textAlign = 'left';
      ctx.fillText(text, pillX + padX, pillY + pillH / 2);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function mainLoop() {
    const now = performance.now();
    updateDecisionCardVisibility();

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    viewTransform = computeViewTransform();
    drawFrames(now);
    drawEdges();
    drawNodes(now);
    if (showDecisions) drawFloatingDecisionNodes(now);
    else decisionNodeRects.length = 0;
    if (showTodos) drawFloatingTodoNodes(now);
    else todoNodeRects.length = 0;
    drawAggregates(now);
    drawHoverPill(now);
    drawCompactHoverBadge(now);
    drawLiveEffects(now);

    requestAnimationFrame(mainLoop);
  }

  const decisionCardEl = document.getElementById('decision-card');
  const cardScrimEl = document.getElementById('card-scrim');

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function refPillHtml(ref, refIdx) {
    let type = '';
    let name = '';
    if (ref.kind === 'frame') {
      type = 'frame';
      name = ref.label || ref.id;
    } else if (ref.kind === 'file') {
      type = 'file';
      name = ref.path.split('/').slice(-1)[0];
    } else if (ref.kind === 'function') {
      type = 'fn';
      name = ref.name + '()';
    } else if (ref.kind === 'symbol') {
      type = 'symbol';
      name = ref.name;
    } else if (ref.kind === 'decision') {
      type = 'decision';
      // Show the friendly D-<seq> form (consistent with the card header and
      // pills); the click handler still keys on ref.id via data-ref.
      name = decisionDisplayId(DECISIONS[ref.id] || ref);
    } else if (ref.kind === 'todo') {
      type = 'todo';
      // Use caller-supplied name when provided (e.g. "T-001 · summary" from the
      // decision-card Tasks section); fall back to the display-id lookup.
      name = ref.name || todoDisplayId(TODOS[ref.id] || ref);
    } else if (ref.kind === 'pr') {
      type = 'pr';
      name = ref.id ? `#${ref.id}` : (ref.name || ref.id || '');
    } else {
      type = ref.kind || '';
      name = ref.name || ref.id || ref.path || '';
    }
    const refData = encodeURIComponent(JSON.stringify(ref));
    return `<span class="dc-ref-pill" data-ref-kind="${escapeHtml(ref.kind)}" data-ref="${refData}"><span class="type">${escapeHtml(type)}</span><span class="name">${escapeHtml(name)}</span></span>`;
  }

  function renderDecisionCard(decId) {
    const dec = DECISIONS[decId] || removedRecordSnapshots[decId];
    if (!dec) { decisionCardEl.innerHTML = ''; return; }
    const isRemoved = !DECISIONS[decId];

    const stateLabel = dec.state;
    const provParts = [];
    if (dec.id) provParts.push(`id ${escapeHtml(dec.id)}`); // canonical id (display id is the D-<seq> form)
    if (dec.proposedBy) provParts.push(`proposed by <span class="agent">@${dec.proposedBy}</span>`);
    if (dec.proposedAt) provParts.push(`on ${dec.proposedAt}`);

    let html = '';
    html += `<div class="dc-header">
      <div class="dc-id-block">
        <div class="dc-id-row">
          <span class="dc-id">${escapeHtml(decisionDisplayId(dec))}</span>
          <span class="dc-state-pill ${stateLabel}"><span class="sw"></span>${stateLabel}</span>
        </div>
        <div class="dc-summary">${escapeHtml(dec.summary)}</div>
        ${provParts.length ? `<div class="dc-provenance">${provParts.join(' · ')}</div>` : ''}
        ${isRemoved ? '<div class="dc-removed-note">this decision was removed · view is a snapshot</div>' : ''}
      </div>
      <button class="dc-close" id="dc-close" aria-label="close">×</button>
    </div>`;

    html += '<div class="dc-body">';

    if (dec.problem) {
      html += `<div class="dc-section"><div class="dc-section-label">problem</div><div class="dc-prose">${escapeHtml(dec.problem)}</div></div>`;
    }
    if (dec.resolution) {
      html += `<div class="dc-section"><div class="dc-section-label">resolution</div><div class="dc-prose">${escapeHtml(dec.resolution)}</div></div>`;
    }
    if (dec.rationale) {
      html += `<div class="dc-section"><div class="dc-section-label">rationale</div><div class="dc-prose">${escapeHtml(dec.rationale)}</div></div>`;
    }
    if (dec.alternatives && dec.alternatives.length) {
      html += `<div class="dc-section"><div class="dc-section-label">alternatives considered</div><div class="dc-alt-list">`;
      dec.alternatives.forEach(alt => {
        html += `<div class="dc-alt"><div class="dc-alt-title">${escapeHtml(alt.title)}</div><div class="dc-alt-reason">${escapeHtml(alt.reason)}</div></div>`;
      });
      html += `</div></div>`;
    }
    if (dec.governs && dec.governs.length) {
      html += `<div class="dc-section"><div class="dc-section-label">governs</div><div class="dc-ref-row">${dec.governs.map(refPillHtml).join('')}</div></div>`;
    }
    if (dec.supersedes || dec.supersededBy) {
      html += `<div class="dc-section"><div class="dc-section-label">supersession</div><div class="dc-supersedes-row">`;
      if (dec.supersedes) {
        html += `<span class="dc-supersedes-arrow">supersedes</span>${refPillHtml({ kind: 'decision', id: dec.supersedes })}`;
      }
      if (dec.supersededBy) {
        if (dec.supersedes) html += `<span class="dc-supersedes-arrow" style="margin-left: 6px;">·</span>`;
        html += `<span class="dc-supersedes-arrow">superseded by</span>${refPillHtml({ kind: 'decision', id: dec.supersededBy })}`;
      }
      html += `</div></div>`;
    }
    if (dec.relatedTo && dec.relatedTo.length) {
      html += `<div class="dc-section"><div class="dc-section-label">related</div><div class="dc-ref-row">${dec.relatedTo.map(id => refPillHtml({ kind: 'decision', id })).join('')}</div></div>`;
    }

    const childTodoIds = SPAWNS_FROM[dec.id] || [];
    if (childTodoIds.length) {
      html += `<div class="dc-section"><div class="dc-section-label">tasks</div><div class="dc-ref-row">`;
      html += childTodoIds.map((id) => {
        const t = TODOS[id];
        const label = t ? `${todoDisplayId(t)} · ${t.summary}` : id;
        return refPillHtml({ kind: 'todo', id, name: label });
      }).join('');
      html += `</div></div>`;
    }

    html += '</div>';
    decisionCardEl.innerHTML = html;

    const closeBtn = document.getElementById('dc-close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeDecisionCard());

    wireCardRefPills();
  }

  function wireCardRefPills() {
    decisionCardEl.querySelectorAll('.dc-ref-pill').forEach(el => {
      el.addEventListener('click', () => {
        const refData = el.dataset.ref;
        if (!refData) return;
        let ref;
        try { ref = JSON.parse(decodeURIComponent(refData)); } catch { return; }

        if (ref.kind === 'decision') {
          if (DECISIONS[ref.id]) openDecisionCard(ref.id);
          return;
        }

        if (ref.kind === 'todo') {
          if (TODOS[ref.id]) openRecord('todo', ref.id);
          return;
        }

        let frameId = null;
        if (ref.kind === 'frame') {
          frameId = ref.id;
        } else if (ref.path) {
          frameId = frameIdForPath(FRAME_PATH_INDEX, ref.path);
        }
        if (frameId) {
          closeDecisionCard();
          setFocus(frameId);
        }
      });
    });
  }

  function renderTodoCard(todoId) {
    const t = TODOS[todoId] || removedRecordSnapshots[todoId];
    if (!t) { decisionCardEl.innerHTML = ''; return; }
    const isRemoved = !TODOS[todoId];
    const provParts = [];
    if (t.id) provParts.push(`id ${escapeHtml(t.id)}`); // canonical id (display id is the T-<seq> form)
    if (t.proposedBy) provParts.push(`proposed by <span class="agent">@${escapeHtml(t.proposedBy)}</span>`);
    if (t.proposedAt) provParts.push(`on ${escapeHtml(t.proposedAt)}`);

    let html = `<div class="dc-header"><div class="dc-id-block">
      <div class="dc-id-row">
        <span class="dc-id todo">${escapeHtml(todoDisplayId(t))}</span>
        <span class="dc-state-pill ${escapeHtml(t.state || '')}"><span class="sw"></span>${escapeHtml(t.state || '')}</span>
      </div>
      <div class="dc-summary">${escapeHtml(t.summary || '')}</div>
      ${provParts.length ? `<div class="dc-provenance">${provParts.join(' · ')}</div>` : ''}
      ${isRemoved ? '<div class="dc-removed-note">this todo was removed · view is a snapshot</div>' : ''}
    </div><button class="dc-close" id="dc-close" aria-label="close">×</button></div>`;

    html += '<div class="dc-body">';
    if (t.description) html += `<div class="dc-section"><div class="dc-section-label">description</div><div class="dc-prose">${escapeHtml(t.description)}</div></div>`;
    if (t.governs?.length) html += `<div class="dc-section"><div class="dc-section-label">governs</div><div class="dc-ref-row">${t.governs.map(refPillHtml).join('')}</div></div>`;
    if (t.spawnsFrom) html += `<div class="dc-section"><div class="dc-section-label">spawned from</div><div class="dc-ref-row">${refPillHtml({ kind: 'decision', id: t.spawnsFrom })}</div></div>`;
    if (t.resolvedBy?.length) html += `<div class="dc-section"><div class="dc-section-label">resolved by</div><div class="dc-ref-row">${t.resolvedBy.map(id => refPillHtml({ kind: 'pr', id })).join('')}</div></div>`;
    if (t.blockedBy?.length || t.blocks?.length) {
      html += `<div class="dc-section"><div class="dc-section-label">dependencies</div><div class="dc-ref-row">`;
      html += (t.blockedBy || []).map(r => refPillHtml({ kind: 'todo', id: r.id })).join('');
      html += (t.blocks || []).map(r => refPillHtml({ kind: 'todo', id: r.id })).join('');
      html += `</div></div>`;
    }
    if (t.relatedTo?.length) html += `<div class="dc-section"><div class="dc-section-label">related</div><div class="dc-ref-row">${t.relatedTo.map(r => refPillHtml({ kind: 'todo', id: r.id })).join('')}</div></div>`;
    html += '</div>';
    decisionCardEl.innerHTML = html;

    const closeBtn = document.getElementById('dc-close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeRecord());
    wireCardRefPills();
  }

  let currentRenderedRecord = null;

  function sameRecord(a, b) {
    if (!a || !b) return false;
    return a.type === b.type && a.id === b.id;
  }

  function updateDecisionCardVisibility() {
    if (focusedRecord && !sameRecord(focusedRecord, currentRenderedRecord)) {
      if (focusedRecord.type === 'decision') {
        renderDecisionCard(focusedRecord.id);
      } else if (focusedRecord.type === 'todo') {
        renderTodoCard(focusedRecord.id);
      }
      currentRenderedRecord = { ...focusedRecord };
    }
    if (focusedRecord) {
      decisionCardEl.classList.add('visible');
      document.body.classList.add('card-open');
    } else {
      decisionCardEl.classList.remove('visible');
      document.body.classList.remove('card-open');
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (focusedRecord) {
      closeRecord();
    } else if (focusedFrameId) {
      anchorNodeIdx = null;
      setFocus(null);
    }
  });

  window.addEventListener('load', async () => {
    resize();
    await initToolbar();
    requestAnimationFrame(mainLoop);
  });
})();
