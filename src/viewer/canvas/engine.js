import { groupNodesIntoFrames, basenames, buildFrameGovernance, withGovernedFramesRendered, buildFramePathIndex, frameIdForPath, buildGovernance, buildSpawnsFromIndex, filterAmbientTodos, todoDotColor, frameIdsForRefs, primaryRefPath, buildFrameAdjacency, frameBfsPath, partitionSpotlightRefs, resolveEmphasisPairs } from './adapters.js';
import { createLiveEffects } from './live-effects.js';
import { createPresence, PRESENCE_COLORS } from './presence.js';
import { createCamera, compose, zoomAt, panBy, settleTarget, isIdentity, lerpCamera, MAX_ZOOM } from './camera.js';
import { dotBudget, labelAlpha, shedAlpha, applyHysteresis, interEdgeZoomFade, quantizeAlpha } from './lod.js';
import { captureGeometry, beginMorph, morphGeom, morphActive } from './layout-morph.js';

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

export function createEngine({ canvas, store, callbacks = {}, isLight: isLightFn = undefined, storagePrefix = 'cortex.viewer' }) {
  const ctx = canvas.getContext('2d');
  const DPR = window.devicePixelRatio || 1;

  // Theme probe — injectable so an embedder (Mesh) can bind its own theme
  // attribute; default preserves the Cortex viewer's body-class convention.
  const isLight = isLightFn ?? (() => document.body.classList.contains('light'));

  // Canvas-side theme helpers — small, intentional, not a full abstraction
  function frameBorderRGB()       { return isLight() ? [0, 0, 0]       : [255, 255, 255]; }
  // Light-mode frames fill with dark ink at low alpha: a white fill on the
  // #fafafa page was invisible, which read as "frames are missing" in light mode.
  function frameFillRGB()         { return isLight() ? [24, 24, 27]    : [14, 14, 17]; }
  function nodeBaseRGB()          { return isLight() ? [82, 82, 91]    : [113, 113, 122]; }
  // Edges get their own ink: light mode stays off pure black (at the
  // frame-border alphas, black made the edge web dominate the scene) but must
  // be dark enough to register. zinc-500 at the old alphas put a min-weight
  // inter-frame edge ~7/255 off the #fafafa page — below the threshold where a
  // 1px line reads at all. zinc-700 roughly doubles that delta while keeping
  // the web recessive.
  function edgeRGB()              { return isLight() ? [63, 63, 70]    : [255, 255, 255]; }
  function pillBgRGB()            { return isLight() ? [255, 255, 255] : [17, 18, 27]; }
  function pillBgGreenRGB()       { return isLight() ? [250, 253, 251] : [13, 17, 14]; }
  function pillTextRGB()          { return isLight() ? [24, 24, 27]    : [237, 237, 237]; }
  function primaryLabelRGB()      { return isLight() ? [24, 24, 27]    : [237, 237, 237]; }
  function subLabelRGB()          { return isLight() ? [113, 113, 122] : [161, 161, 170]; }
  function countIdleRGB()         { return isLight() ? [113, 113, 122] : [82, 82, 91]; }

  const LAYERS_LS_KEY = `${storagePrefix}.layers`;
  let layersOn = false;
  try { layersOn = localStorage.getItem(LAYERS_LS_KEY) === '1'; } catch { /* sandboxed */ }

  const SHOW_LS = {
    frames: `${storagePrefix}.show.frames`,
    decisions: `${storagePrefix}.show.decisions`,
    todos: `${storagePrefix}.show.todos`,
    presence: `${storagePrefix}.show.presence`,
  };
  function readShow(key) {
    try { return localStorage.getItem(key) !== '0'; } catch { return true; } // default ON
  }
  let showFrames = readShow(SHOW_LS.frames);
  let showDecisions = readShow(SHOW_LS.decisions);
  let showTodos = readShow(SHOW_LS.todos);
  let showPresence = readShow(SHOW_LS.presence);

  /** UI command from React — persistence of the prefs moves React-side. */
  function setLayerPrefs(p) {
    if (p.showFrames !== undefined) showFrames = p.showFrames;
    if (p.showDecisions !== undefined) showDecisions = p.showDecisions;
    if (p.showTodos !== undefined) showTodos = p.showTodos;
    if (p.layerTint !== undefined) layersOn = p.layerTint;
    if (typeof p.showPresence === 'boolean') showPresence = p.showPresence;
    invalidate();
  }

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

  let FRAMES = [];
  let frameById = new Map();
  let NODE_CFG = {};
  let FILE_NAMES = {};
  let FRAME_FILE_PATHS = {};
  // file_path → frameIdStr, for matching decision-governed file paths to the
  // frame that actually contains the file (membership, not label resemblance).
  let FRAME_PATH_INDEX = new Map();

  const nodes = [];
  const edges = [];
  const adjacency = {};
  // file_path → canvas node index, for resolving a presence ref to its dot so
  // the presence cursor can target the actual dot (not the frame center) when
  // that dot is currently drawn. Rebuilt by buildGraph.
  let PATH_TO_IDX = new Map();

  let focusedFrameId = null;
  let focusT0 = 0;
  const FOCUS_DURATION = 550;
  let previousFocusId = null;

  // Layout morph (see layout-morph.js): a re-index recomputes the whole frame
  // map, so a data swap can move every frame at once. Rather than cutting
  // between the two layouts, surviving frames glide from old to new. Null when
  // idle, and every draw path is pixel-identical to pre-morph when it is.
  let layoutMorph = null;

  // Held show-focus spotlight (slice 2a). Null = inert (every draw path must be
  // pixel-identical to pre-spotlight when null). When active:
  //   { frameSet, decSet, todoSet: Set<string>, t0 } — t0 anchors the dim ease.
  // Set members are String()-coerced ids: frame ids for frames, and both the
  // seq display id (D-12 / T-3) and canonical id for dots, so a ref in either
  // form matches. Cleared on setData (project switch/resync wipes it — the
  // agent re-issues focus). Fires callbacks.onSpotlight(payload|null).
  let spotlight = null;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const liveFx = createLiveEffects({ reducedMotion });
  // Live agent-presence layer (avatars, session-colored heat, traversal
  // synapses). Pure state like liveFx; the engine feeds it BFS paths over the
  // frame graph and pushes roster snapshots to React via onPresenceRoster.
  const presenceFx = createPresence({ reducedMotion });
  // Max stroke alpha for the two presence-heat tiers. Flash is the prominent
  // wide border; trail is the faint slow-decay outline (~1/3 of flash).
  const PRESENCE_FLASH_ALPHA = 0.35;
  const PRESENCE_TRAIL_ALPHA = 0.12;
  // Undirected frame adjacency for traversal pathfinding, rebuilt on every
  // setData (project switch) from the same inter-frame connectivity the edge
  // web draws (FILE_EDGES resolved through FRAME_PATH_INDEX).
  let FRAME_ADJ = new Map();
  const DECISIONS = store.state.decisions; // aliases — object identity is stable
  let FRAME_GOVERNANCE = {};
  const TODOS = store.state.todos;
  let TODO_GOVERNANCE = {};
  let SPAWNS_FROM = {};
  let AGGREGATES = [];
  let FILE_EDGES = [];

  // Cached frame metadata from the last setData, used by the incremental
  // apply path to recompute promoted-frame overlays without a full reload.
  let lastFrameMeta = null;

  function getDecision(id) { return DECISIONS[id]; }
  function getFrameDecisions(frameId) {
    return (FRAME_GOVERNANCE[frameId] || []).map(getDecision).filter(Boolean);
  }
  function getFrameTodos(frameId) {
    return (TODO_GOVERNANCE[frameId] || []).map((id) => TODOS[id]).filter(Boolean);
  }

  /** Assign the pre-adapted data bundle (Task 3's adaptProjectData) and rebuild
   *  the in-canvas graph. This is the assignment tail of the old loadGraph —
   *  fetching/adapting now happens in React; the engine only owns render state. */
  function setData(bundle, { preserveFocus = false } = {}) {
    // Capture the outgoing layout BEFORE the swap so a re-index glides into its
    // new positions instead of cutting. beginMorph returns null for a first
    // load, a no-op resync, or reduced motion — all of which should snap.
    layoutMorph = beginMorph(captureGeometry(FRAMES), bundle.frames, performance.now(), { reducedMotion });

    FRAMES = bundle.frames;
    frameById = new Map(FRAMES.map((f) => [f.id, f]));
    NODE_CFG = bundle.nodeCfg;
    FILE_NAMES = bundle.fileNames;
    FRAME_FILE_PATHS = bundle.frameFilePaths;
    FRAME_PATH_INDEX = bundle.framePathIndex;
    FRAME_GOVERNANCE = bundle.frameGovernance;
    TODO_GOVERNANCE = bundle.todoGovernance;
    SPAWNS_FROM = bundle.spawnsFrom;
    AGGREGATES = bundle.aggregates;
    FILE_EDGES = bundle.fileEdges;
    lastFrameMeta = bundle.frameMeta;
    // Rebuild presence traversal adjacency from the inter-frame connectivity.
    // Each FileEdge is a file→file pair; resolve both endpoints to their frame
    // via FRAME_PATH_INDEX. buildFrameAdjacency drops null/self/intra-frame
    // pairs, leaving an undirected frame-to-frame graph for frameBfsPath.
    FRAME_ADJ = buildFrameAdjacency(
      (FILE_EDGES || []).map((fe) => ({
        a: frameIdForPath(FRAME_PATH_INDEX, fe.from_path),
        b: frameIdForPath(FRAME_PATH_INDEX, fe.to_path),
      })),
    );
    buildGraph();
    // A project switch/resync invalidates any held spotlight (frame ids collide
    // across projects, dot ids don't carry over) — clear it and notify React so
    // the store's spotlight banner drops. The agent re-issues focus if wanted.
    if (spotlight) {
      spotlight = null;
      callbacks.onSpotlight?.(null);
    }
    if (!preserveFocus) {
      focusedFrameId = null;
      previousFocusId = null;
      // Frame ids collide across projects (every project has a frame "1"), so
      // a project switch must not reuse the old project's reveal state — reset
      // for an instant calibrated render. The resnapshot path (preserveFocus:
      // true) keeps its reveal state for continuity.
      for (const k of Object.keys(frameReveal)) delete frameReveal[k];
    }
    invalidateFrameGeometry();
    invalidate();
  }

  // ── Live agent presence ────────────────────────────────────────────────
  // Ingest a batch of presence events from React. Each event carries a payload
  // (session_id, workspace, activity, refs) and a `live` flag (false = replayed
  // history, which teleports rather than animates). Resolves each session's
  // pending traversal target into a BFS path over FRAME_ADJ and hands it back to
  // presenceFx. Inert until events arrive: no events → empty roster → no draw.
  function applyPresence(events) {
    if (!events || events.length === 0) return;
    const now = performance.now();
    for (const ev of events) {
      const p = ev.payload || {};
      presenceFx.noteActivity({
        sessionId: p.session_id,
        workspace: p.workspace,
        activity: p.activity,
        frameIds: frameIdsForRefs(FRAME_PATH_INDEX, p.refs || []),
        targetPath: primaryRefPath(FRAME_PATH_INDEX, p.refs || []),
        now,
        animate: ev.live !== false,
      });
      const pending = presenceFx.pendingTarget(p.session_id);
      if (pending) {
        const path = pending.fromFrameId
          ? frameBfsPath(FRAME_ADJ, pending.fromFrameId, pending.toFrameId)
          : [];
        presenceFx.setPath(p.session_id, path.length >= 2 ? path : [pending.toFrameId], now);
      }
    }
    invalidate();
    scheduleRosterCallback();
  }

  // Roster snapshots reach React through onPresenceRoster, throttled to at most
  // once per second and fired only when the roster content actually changes
  // (idle/gone transitions age without events, so mainLoop also pokes this).
  let lastRosterJson = null;
  let rosterTimer = null;
  function emitRosterIfChanged() {
    rosterTimer = null;
    if (!callbacks.onPresenceRoster) return;
    const roster = presenceFx.roster(performance.now());
    const json = JSON.stringify(roster);
    if (json === lastRosterJson) return;
    lastRosterJson = json;
    callbacks.onPresenceRoster(roster);
  }
  function scheduleRosterCallback() {
    if (!callbacks.onPresenceRoster) return; // no listener → nothing to schedule
    if (rosterTimer !== null) return; // a check is already pending within this 1s window
    rosterTimer = setTimeout(emitRosterIfChanged, 1000);
  }

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
          indexInFrame: i,
          kind: 'file',
          file_path: paths[i] || null,
          rx: pos.rx,
          ry: pos.ry,
          name: names[i] || 'n-' + i,
        });
        adjacency[nodes.length - 1] = [];
      }
      // Reveal order: seeded scatter so a partial budget samples the whole
      // grid instead of filling the top rows (positions stay index-seeded).
      const order = Array.from({ length: cfg.count }, (_, k) => k);
      const rng = mulberry32(fnv1a('reveal:' + frame.id));
      for (let k = order.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [order[k], order[j]] = [order[j], order[k]];
      }
      for (let k = 0; k < cfg.count; k++) {
        nodes[nodes.length - cfg.count + k].revealRank = order[k];
      }
    });

    function addEdge(a, b, interFrame, weight) {
      const edge = { a, b, intensity: 0, interFrame, weight: weight || 1 };
      edges.push(edge);
      adjacency[a].push({ to: b, edge: edges.length - 1 });
      adjacency[b].push({ to: a, edge: edges.length - 1 });
    }

    // Build path → canvas-index lookup for the visible (capped) nodes. Hoisted
    // to closure scope (PATH_TO_IDX) so the presence layer can resolve a ref's
    // path to its dot for the dot-level cursor approach.
    const pathToIdx = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i].file_path;
      if (p) pathToIdx.set(p, i);
    }
    PATH_TO_IDX = pathToIdx;

    // Real edges from /api/file-edges. Each FileEdge already has a weight
    // (count of underlying entity-level CALLS, threshold ≥ 2 server-side).
    // Edges where either endpoint isn't on canvas (in noise / auxiliary
    // content, outside any frame) are silently dropped. The per-frame LOD
    // dot budget is applied at draw time (lod.js), not here.
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
      }
    }

    if (needsPromotionRebuild && lastFrameMeta) {
      // Rare path: a change governs a frame outside the render set — recompute
      // the promoted-frames overlay + canvas graph (documented spec exception).
      FRAMES = withGovernedFramesRendered(FRAMES.filter((f) => !f.promotedForGovernance), FRAME_GOVERNANCE, lastFrameMeta);
      frameById = new Map(FRAMES.map((f) => [f.id, f]));
      buildGraph();
      invalidateFrameGeometry();
    }
    onLiveChangesApplied(changes);
    invalidate();
  }

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

  /** Held show-focus spotlight command from React. `null`, `refs: []`, or a
   *  resolution with no frames/decisions/todos AND no ids clears the spotlight
   *  (fires onSpotlight(null)). Otherwise stores the resolved Sets + an ease
   *  anchor and fires onSpotlight with the exact ui-store shape Task 7 stores
   *  verbatim: { note, resolved: { frames, decisions, todos }, unresolved }. */
  function applySpotlight(cmd) {
    invalidate(); // every path below mutates (or clears) the held spotlight
    if (!cmd || !cmd.refs || cmd.refs.length === 0) {
      spotlight = null;
      callbacks.onSpotlight?.(null);
      return;
    }
    const { frameIds, decisionIds, todoIds, unresolved } =
      partitionSpotlightRefs(FRAME_PATH_INDEX, cmd.refs);
    // Nothing resolved and nothing left dangling → treat as a clear.
    if (!frameIds.length && !decisionIds.length && !todoIds.length && !unresolved.length) {
      spotlight = null;
      callbacks.onSpotlight?.(null);
      return;
    }
    // Dots carry canonical ids; refs arrive as seq display ids (D-12 / T-3).
    // Coerce both into the Sets so membership matches regardless of ref form.
    const decSet = new Set();
    for (const id of decisionIds) decSet.add(String(id));
    const todoSet = new Set();
    for (const id of todoIds) todoSet.add(String(id));
    spotlight = {
      frameSet: new Set(frameIds.map(String)),
      decSet,
      todoSet,
      t0: performance.now(),
    };
    spotlight.emphasis = Array.isArray(cmd.emphasis_edges)
      ? resolveEmphasisPairs(FRAME_PATH_INDEX, cmd.emphasis_edges)
      : [];
    if (cmd.fit) fitToFrames(frameIds);
    callbacks.onSpotlight?.({
      note: cmd.note,
      resolved: { frames: frameIds, decisions: decisionIds, todos: todoIds },
      unresolved,
    });
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

  // ── Camera: pure post-transform on the fit view (see camera.js). Identity
  // renders exactly today's fit-to-content scene. Animated moves reuse the
  // focus-transition idiom (ease + FOCUS_DURATION).
  let camera = createCamera();
  let camAnim = null; // { from, to, t0 }
  function cameraNow(now) {
    if (!camAnim) return camera;
    const t = Math.min(1, (now - camAnim.t0) / FOCUS_DURATION);
    camera = lerpCamera(camAnim.from, camAnim.to, ease(t));
    if (t >= 1) { camera = camAnim.to; camAnim = null; callbacks.onCameraChange?.({ ...camera }); }
    return camera;
  }
  function setCamera(next, { animate = false } = {}) {
    if (animate) { camAnim = { from: { ...camera }, to: { ...next }, t0: performance.now() }; }
    else { camera = { ...next }; camAnim = null; callbacks.onCameraChange?.({ ...camera }); }
    invalidate();
  }

  function computeViewTransform() {
    const stageW = canvas.clientWidth || 1;
    const stageH = canvas.clientHeight || 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let sw = 0, scx = 0, scy = 0; // area-weighted centroid accumulators
    // Measured on the MORPHING geometry: during a re-index glide the fit has to
    // travel with the frames, or the scene would rescale instantly under frames
    // that are still moving — two competing motions instead of one.
    for (const fr of FRAMES) {
      const f = frameGeom(fr);
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

  /** Frame geometry in normalized stage space, mid-morph-aware — an ease between
   *  the frame's old and new stage coords while a re-index morph runs, and the
   *  frame's own values otherwise. */
  function frameGeom(frame, now = performance.now()) {
    return morphGeom(layoutMorph, frame, now, ease);
  }

  function framePxBase(frame) {
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const v = viewTransform;
    const g = frameGeom(frame);
    // Map the virtual-stage fraction to raw canvas px, then apply the
    // fit-to-content transform (centers the scene; clamping is unnecessary —
    // the transform already keeps all content within the padded canvas).
    return {
      cx: (g.x * stageW) * v.scale + v.ox,
      cy: (g.y * stageH) * v.scale + v.oy,
      w: g.w * v.scale,
      h: g.h * v.scale,
    };
  }

  /** Animate the camera to fit the given frames (bbox of their fit-space rects,
   *  padded), zoom clamped to [1, MAX_ZOOM]. Empty/unknown set → identity (fit
   *  view). reducedMotion snaps instead of animating. */
  function fitToFrames(frameIds) {
    const ids = new Set([...frameIds].map(String));
    const stageW = canvas.clientWidth || 1, stageH = canvas.clientHeight || 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Measure in camera-FREE fit space (computeViewTransform), not framePxBase —
    // framePxBase reads the module-level viewTransform, which mainLoop overwrites
    // every tick with compose(fit, camera). Measuring through it would fit against
    // already-panned/zoomed screen px, compounding on every non-identity camera.
    const v = computeViewTransform();
    for (const fr of FRAMES) {
      if (!ids.has(String(fr.id))) continue;
      const f = frameGeom(fr); // morph-aware, so a spotlight mid-glide still frames what's on screen
      const cx = (f.x * stageW) * v.scale + v.ox;
      const cy = (f.y * stageH) * v.scale + v.oy;
      const w = f.w * v.scale, h = f.h * v.scale;
      minX = Math.min(minX, cx - w / 2); maxX = Math.max(maxX, cx + w / 2);
      minY = Math.min(minY, cy - h / 2); maxY = Math.max(maxY, cy + h / 2);
    }
    const animate = !reducedMotion;
    if (!isFinite(minX)) { setCamera(createCamera(), { animate }); return; }
    const PAD = 70;   // spotlight framing margin: clears card chrome + frame labels
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const zoom = Math.max(1, Math.min((stageW - 2 * PAD) / w, (stageH - 2 * PAD) / h, MAX_ZOOM));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    setCamera({ zoom, panX: stageW / 2 - cx * zoom, panY: stageH / 2 - cy * zoom }, { animate });
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

    return displacedByFocus(framePxBase(frame), frame.w, frame.h, focusedId);
  }

  /** Where a NON-focused item sits while `focusedId` is open: pushed radially
   *  outward from the canvas centre to clear the focused card, and compressed.
   *
   *  Extracted from framePxFocused so aggregate dots can take the SAME
   *  displacement. Aggregates previously read only the fit transform, so opening
   *  a frame slid every frame aside while the aux dots stayed nailed in place —
   *  ending up on top of the focused card, visually detached from the cloud they
   *  annotate.
   *
   *  `rawW`/`rawH` are the item's uncompressed dims in whatever units the caller
   *  compresses in (frames have always passed stage-space w/h here). */
  function displacedByFocus(base, rawW, rawH, focusedId) {
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const cxCanvas = stageW / 2;
    const cyCanvas = stageH / 2;
    const dx = base.cx - cxCanvas;
    const dy = base.cy - cyCanvas;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    const focusedFrame = frameById.get(focusedId);
    if (!focusedFrame) return base;
    const frame = { w: rawW, h: rawH };
    const focusedW = Math.min(stageW * 0.55, 560);
    const focusedH = Math.min(stageH * 0.55, 360);

    const compressedW = frame.w * 0.55;
    const compressedH = frame.h * 0.55;

    const targetDistX = focusedW / 2 + compressedW / 2 + 40;
    const targetDistY = focusedH / 2 + compressedH / 2 + 30;

    // Distance along this item's OWN ray at which it clears the focused card:
    // the first axis the ray crosses bounds it (a near-zero component →
    // Infinity, so min() picks the other axis). Items already further out stay
    // where they are.
    //
    // This was a max(), which demands clearing BOTH axes at once — unreachable
    // for a ray near either axis, so those items were flung to tens of thousands
    // of px and the clamp below pinned them to the canvas edge. Every frame near
    // a horizontal or vertical from centre landed on that clamp, drawing the
    // rectangular border seen around an opened frame; the more frames on the
    // canvas, the more solid that rectangle got. Same failure `pushOutsideCloud`
    // was already corrected for on the cloud keep-out: a ray exits a box on ONE
    // axis, and picking the far one flings items into empty space.
    const tx = Math.abs(ux) > 1e-6 ? targetDistX / Math.abs(ux) : Infinity;
    const ty = Math.abs(uy) > 1e-6 ? targetDistY / Math.abs(uy) : Infinity;
    const pushed = Math.max(dist, Math.min(tx, ty));
    let newCx = cxCanvas + ux * pushed;
    let newCy = cyCanvas + uy * pushed;

    const pad = EDGE_MARGIN;
    newCx = Math.max(compressedW / 2 + pad, Math.min(stageW - compressedW / 2 - pad, newCx));
    newCy = Math.max(compressedH / 2 + pad + LABEL_HEADROOM, Math.min(stageH - compressedH / 2 - pad, newCy));

    return { cx: newCx, cy: newCy, w: compressedW, h: compressedH };
  }

  /** Focus-aware position for an auxiliary dot already mapped to canvas px.
   *  Mirrors framePx's source→target ease so aux nodes travel with the frames
   *  instead of staying pinned while the rest of the canvas moves. */
  function aggregatePx(cx, cy, size) {
    const fp = computeFocusProgress();
    const base = { cx, cy, w: size, h: size };
    if (!fp.focused && !fp.from) return base;
    const target = fp.focused ? displacedByFocus(base, size, size, fp.focused) : base;
    const source = fp.from ? displacedByFocus(base, size, size, fp.from) : base;
    if (fp.t >= 1) return target;
    return {
      cx: source.cx + (target.cx - source.cx) * fp.t,
      cy: source.cy + (target.cy - source.cy) * fp.t,
      w: source.w + (target.w - source.w) * fp.t,
      h: source.h + (target.h - source.h) * fp.t,
    };
  }

  const framePxCache = new Map(); // cleared per tick — framePx is pure within one frame
  /** Geometry changed outside the rAF tick (resize / data swap): refresh the
   *  view transform (framePxBase reads it, and only mainLoop recomputes it),
   *  drop cached framePx values, and recompute the visible set so a hit-test
   *  landing before the next tick sees fresh geometry (recompute — an emptied
   *  set would make nodeAtPoint miss everything during the sub-16ms window).
   *  `camera` (not cameraNow) is correct outside a tick: it holds the current
   *  value, and mid-animation the next rAF re-lerps anyway. */
  function invalidateFrameGeometry() {
    viewTransform = compose(computeViewTransform(), camera);
    framePxCache.clear();
    computeVisibleFrames();
  }
  function framePx(frame) {
    const hit = framePxCache.get(frame.id);
    if (hit) return hit;
    const fp = computeFocusProgress();
    const base = framePxBase(frame);
    let out;
    if (!fp.focused && !fp.from) out = base;
    else {
      const target = fp.focused ? framePxFocused(frame, fp.focused) : base;
      const source = fp.from ? framePxFocused(frame, fp.from) : base;
      out = fp.t >= 1 ? target : {
        cx: source.cx + (target.cx - source.cx) * fp.t,
        cy: source.cy + (target.cy - source.cy) * fp.t,
        w:  source.w  + (target.w  - source.w)  * fp.t,
        h:  source.h  + (target.h  - source.h)  * fp.t,
      };
    }
    framePxCache.set(frame.id, out);
    return out;
  }

  // `out` lets hot call sites (drawEdges' two live endpoints, the per-node
  // draw loop, the node hit-test loop) write into a reusable scratch object
  // instead of allocating a fresh {x,y} every call. Callers that need to
  // retain the result past the NEXT nodePx call (e.g. an array of positions
  // read back later, or a returned {x,y} the caller stores) must omit `out`
  // and let this allocate — see the Task-9 call-site audit in the report.
  function nodePx(node, out) {
    const frame = frameById.get(node.frameId);
    const f = framePx(frame);
    const p = out || {};
    p.x = f.cx - f.w / 2 + node.rx * f.w;
    p.y = f.cy - f.h / 2 + node.ry * f.h;
    return p;
  }

  // Module-scope scratch objects for the hot nodePx call sites (Task 9).
  // drawEdges needs two — both endpoints of an edge are alive simultaneously.
  const _edgeA = { x: 0, y: 0 };
  const _edgeB = { x: 0, y: 0 };
  const _nodeDrawScratch = { x: 0, y: 0 }; // drawNodes' per-node loop
  const _hitTestScratch = { x: 0, y: 0 };  // nodeAtPoint's per-node hit-test loop

  // ── LOD: per-frame animated dot reveal. `shown` glides toward the budget;
  // dot i draws at alpha clamp(shown - i, 0, 1) so reveals/sheds fade
  // sequentially instead of popping (§0.4).
  const REVEAL_MS = 240;
  const frameReveal = {}; // frameId → { shown, target, from, t0 }
  let lodByFrame = new Map(); // frameId → { shown, label } — rebuilt per tick
  let detailShed = 1;
  function computeLod(now) {
    lodByFrame = new Map();
    detailShed = shedAlpha(camera.zoom);
    for (const fr of FRAMES) {
      if (!visibleFrames.has(fr.id)) continue;
      const f = framePx(fr);
      const members = (NODE_CFG[fr.id] || { count: 0 }).count;
      const rawTarget = dotBudget(f.w * f.h, members);
      let st = frameReveal[fr.id];
      if (!st) st = frameReveal[fr.id] = { shown: rawTarget, target: rawTarget, from: rawTarget, t0: 0 };
      const target = applyHysteresis(st.target, rawTarget);
      if (target !== st.target) { st.from = st.shown; st.target = target; st.t0 = now; }
      const t = st.t0 === 0 ? 1 : Math.min(1, (now - st.t0) / REVEAL_MS);
      st.shown = st.from + (st.target - st.from) * ease(t);
      const spacing = Math.sqrt((f.w * f.h) / Math.max(1, st.target));
      lodByFrame.set(fr.id, { shown: st.shown, label: labelAlpha(spacing) });
    }
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
    invalidate();
  }

  function closeRecord() {
    if (focusedRecord === null) return;
    previousRecord = focusedRecord;
    focusedRecord = null;
    recordDrawerT0 = performance.now();
    for (const k of Object.keys(removedRecordSnapshots)) delete removedRecordSnapshots[k];
    invalidate();
  }

  /** External command (React: drawer pills / palette / list). */
  function setActiveRecord(rec) {
    if (rec) openRecord(rec.type, rec.id);
    else closeRecord();
  }

  const frameHoverState = {};

  const HOVER_IN_MS = 180;
  const HOVER_OUT_MS = 220;

  function resize() {
    canvas.width = canvas.clientWidth * DPR;
    canvas.height = canvas.clientHeight * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    invalidateFrameGeometry();
    invalidate();
  }

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
      if (!visibleFrames.has(n.frameId)) return;
      const lod = lodByFrame.get(n.frameId);
      if (lod && lod.shown - n.revealRank < 0.5) return;
      const p = nodePx(n, _hitTestScratch);
      const frame = frameById.get(n.frameId);
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
    invalidate();
    callbacks.onFrameFocus?.(focusedFrameId);
  }

  let mouseX = 0, mouseY = 0;

  canvas.addEventListener('mousemove', (e) => {
    if (panState?.dragging) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    mouseX = px; mouseY = py;

    const marginaliaHit = marginaliaAtPoint(px, py);
    const nodeIdx = marginaliaHit ? null : nodeAtPoint(px, py);
    const labelFrame = (marginaliaHit || !showFrames) ? null : frameLabelAtPoint(px, py);
    const bodyFrame = (marginaliaHit || !showFrames) ? null : frameAtPoint(px, py);

    // Hover invalidation discipline: invalidate() ONLY inside the
    // changed-branches below — never unconditionally per mousemove, or an
    // idle-but-moving cursor would keep the draw loop hot.
    const newHoveredMarginalia = marginaliaHit?.id || null;
    if (newHoveredMarginalia !== hoveredMarginaliaId) {
      hoveredMarginaliaId = newHoveredMarginalia;
      invalidate();
    }

    const newHoveredLabel = labelFrame?.id || null;
    const newHoveredFrame = bodyFrame?.id || null;

    if (newHoveredLabel !== hoveredLabelFrameId) {
      hoveredLabelFrameId = newHoveredLabel;
      invalidate();
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
      invalidate();
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
      invalidate();
    }

    const decHover = decisionNodeAtPoint(px, py);
    const newHoveredDecision = decHover ? decHover.id : null;
    if (newHoveredDecision !== hoveredDecisionId) {
      hoveredDecisionId = newHoveredDecision;
      invalidate();
    }

    const todoHover = todoNodeAtPoint(px, py);
    const newHoveredTodo = todoHover ? todoHover.id : null;
    if (newHoveredTodo !== hoveredTodoId) {
      hoveredTodoId = newHoveredTodo;
      invalidate();
    }

    const aggHover = aggregateAtPoint(px, py);
    const newHoveredAggregate = aggHover ? aggHover.id : null;
    if (newHoveredAggregate !== hoveredAggregateId) {
      hoveredAggregateId = newHoveredAggregate;
      invalidate();
    }

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
    // Rare discrete event (one per canvas exit) — a plain invalidate is fine.
    invalidate();
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
      return;
    }
    // Empty canvas: return the camera to the fit view (identity), animated.
    if (!isIdentity(camera)) setCamera(createCamera(), { animate: true });
  });

  canvas.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const marginaliaHit = marginaliaAtPoint(px, py);
    // The View-all pill is an action, not a record — identical handling
    // whether or not a record drawer is open, so dispatch it before the fork.
    if (marginaliaHit && marginaliaHit.type === 'viewall') {
      callbacks.onViewAll?.(marginaliaHit.frameId, marginaliaHit.tab);
      return;
    }

    if (focusedRecord) {
      if (marginaliaHit) {
        const hitId = marginaliaHit.id;
        if (focusedRecord.type === marginaliaHit.type && String(focusedRecord.id) === hitId) {
          closeRecord();
          callbacks.onRecordDismiss?.();
        } else {
          openRecord(marginaliaHit.type, hitId);
          callbacks.onRecordClick?.(marginaliaHit.type, hitId);
        }
        return;
      }
      const decHit = decisionNodeAtPoint(px, py);
      if (decHit) {
        openRecord('decision', decHit.id);
        callbacks.onRecordClick?.('decision', decHit.id);
        return;
      }
      const todoHit = todoNodeAtPoint(px, py);
      if (todoHit) {
        openRecord('todo', todoHit.id);
        callbacks.onRecordClick?.('todo', todoHit.id);
        return;
      }
      closeRecord();
      callbacks.onRecordDismiss?.();
      return;
    }

    if (marginaliaHit) {
      const hitId = marginaliaHit.id;
      openRecord(marginaliaHit.type, hitId);
      callbacks.onRecordClick?.(marginaliaHit.type, hitId);
      return;
    }

    const decHit = decisionNodeAtPoint(px, py);
    if (decHit) {
      openRecord('decision', decHit.id);
      callbacks.onRecordClick?.('decision', decHit.id);
      return;
    }

    const todoHit = todoNodeAtPoint(px, py);
    if (todoHit) {
      openRecord('todo', todoHit.id);
      callbacks.onRecordClick?.('todo', todoHit.id);
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
      invalidate(); // pin/anchor changed even when focus below is a no-op
      const fpArr = FRAME_FILE_PATHS[n.frameId];
      const fp = fpArr ? fpArr[n.indexInFrame] : null;
      if (fp) callbacks.onFileClick?.({ filePath: fp, frameId: n.frameId });
      if (n.frameId !== focusedFrameId) {
        setFocus(n.frameId);
      }
      return;
    }

    if (pinnedNodeIdx !== null) {
      lastPinnedNodeIdx = pinnedNodeIdx;
      pinnedLeavingT0 = performance.now();
      pinnedNodeIdx = null;
      invalidate();
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

  let wheelSettleTimer = null;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    camAnim = null;
    camera = zoomAt(camera, e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
    invalidate();
    callbacks.onCameraChange?.({ ...camera });
    // Below-fit overscroll (and a leftover pan at the fit floor) springs back
    // once the gesture pauses — same easing family as the focus transition.
    clearTimeout(wheelSettleTimer);
    wheelSettleTimer = setTimeout(settleIfNeeded, 160);
  }, { passive: false });

  // Below-fit is transient (camera.js invariant): spring back to the fit floor
  // whenever a gesture ends — the wheel pause AND every pan-end path. Never
  // settles out from under an active drag (the drag owns the camera); the
  // at-rest identity case is a no-op.
  function settleIfNeeded() {
    const target = settleTarget(camera);
    if (!panState?.dragging && target !== camera && !isIdentity(camera)) setCamera(target, { animate: true });
  }

  let panState = null; // { startX, startY, camAtStart, pointerId, dragging }
  let suppressClick = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    clearTimeout(wheelSettleTimer); // a new gesture cancels any pending wheel settle
    panState = { startX: e.clientX, startY: e.clientY, camAtStart: { ...camera }, pointerId: e.pointerId, dragging: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    // Self-heal: if pointer capture failed and the button was released outside
    // the canvas, no pointerup/pointercancel ever fired here — a buttons-up
    // move means the pan already ended elsewhere. End it WITHOUT suppressing
    // the next click (no trailing canvas click follows an outside release).
    if (panState && e.buttons === 0) { panState = null; canvas.style.cursor = 'default'; settleIfNeeded(); return; }
    if (!panState) return;
    const dx = e.clientX - panState.startX;
    const dy = e.clientY - panState.startY;
    if (!panState.dragging) {
      if (Math.hypot(dx, dy) < 4) return; // click/dblclick/hover stay intact under the threshold
      panState.dragging = true;
      try { canvas.setPointerCapture(panState.pointerId); } catch { /* capture unavailable */ }
      canvas.style.cursor = 'grabbing';
    }
    camAnim = null;
    camera = panBy(panState.camAtStart, dx, dy);
    invalidate();
    callbacks.onCameraChange?.({ ...camera });
  });
  function endPan(suppress) {
    if (panState?.dragging) {
      // Only a real pointerup has a trailing canvas click to eat; a cancelled
      // pointer produces none — suppressing there would eat the NEXT click.
      if (suppress) suppressClick = true;
      canvas.style.cursor = 'default';
    }
    panState = null;
    settleIfNeeded();
  }
  canvas.addEventListener('pointerup', () => endPan(true));
  canvas.addEventListener('pointercancel', () => endPan(false));

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

      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (dotX < -60 || dotX > W + 60 || dotY < -60 || dotY > H + 60) {
        liveFx.recordDotPos(dec.id, dotX, dotY); // keep effect anchors current
        return;
      }

      const state = dec.state;
      const dotColor =
        state === 'stale'      ? [160, 175, 165] :
        state === 'deprecated' ? [134, 239, 172] :
                                 [74, 222, 128];

      liveFx.recordDotPos(dec.id, dotX, dotY);

      const isSelected = selectedDecId === dec.id;
      // Held spotlight: is this decision in the spotlight set? Match either the
      // seq display id (how refs arrive) or the canonical id (belt-and-braces).
      const inSpot = !!spotlight && (spotlight.decSet.has(decisionDisplayId(dec)) || spotlight.decSet.has(String(dec.id)));
      // While a spotlight is active, non-member dots recede to 0.45 opacity
      // (whole-dot: fill, leaders, ring, pill). Members and the no-spotlight
      // case render at full alpha (pixel-identical when spotlight is null).
      if (spotlight && !inSpot) ctx.globalAlpha = 0.45;
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

      // Spotlight ring — same treatment as the selection ring, drawn additively
      // (a decision can be both selected and spotlighted; both rings show).
      if (inSpot) {
        const spotRingAlpha = state === 'proposed' ? 0.32 : 0.5;
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${spotRingAlpha})`;
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
      // Reset the per-dot spotlight fade so the next iteration starts clean.
      if (spotlight && !inSpot) ctx.globalAlpha = 1;
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

      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (dotX < -60 || dotX > W + 60 || dotY < -60 || dotY > H + 60) {
        liveFx.recordDotPos(todo.id, dotX, dotY); // keep effect anchors current
        return;
      }

      const { rgb, ring } = todoDotColor(todo.state);
      // in_progress: no per-assignee identity color in this viewer → yellow base (rgb).

      const isSelected = selectedTodoId === todo.id;
      // Held spotlight membership — match the seq display id or the canonical id.
      const inSpot = !!spotlight && (spotlight.todoSet.has(todoDisplayId(todo)) || spotlight.todoSet.has(String(todo.id)));
      // Non-member dots recede to 0.45 while a spotlight is active (whole-dot).
      if (spotlight && !inSpot) ctx.globalAlpha = 0.45;
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

      // Spotlight ring — same treatment as selection, drawn additively.
      if (inSpot) {
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
      // Reset the per-dot spotlight fade before the next iteration.
      if (spotlight && !inSpot) ctx.globalAlpha = 1;
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
    const fp = computeFocusProgress();
    const hasFocus = !!(fp.focused || (fp.from && fp.t < 1));
    const sharpFrameId = fp.focused;

    FRAMES.forEach(frame => {
      if (!visibleFrames.has(frame.id)) return;
      const f = framePx(frame);
      const isFocused = frame.id === sharpFrameId;
      // Satellite (non-ambient) frames are drawn at half prominence so they
      // don't compete visually with the ambient frames that anchor the layout.
      const alphaMul = frame.deemphasized ? 0.5 : 1;

      let dimLevel = 0;
      if (hasFocus && !isFocused) {
        dimLevel = fp.focused ? fp.t : (1 - fp.t);
      }
      // Held spotlight: frames NOT in the spotlight set dim in, eased over
      // FOCUS_DURATION from t0, composed as the max of any single-focus dim so
      // the two never cancel. Spotlighted frames keep their existing dimLevel.
      if (spotlight && !spotlight.frameSet.has(String(frame.id))) {
        const spotDim = ease(Math.min(1, (now - spotlight.t0) / FOCUS_DURATION));
        dimLevel = Math.max(dimLevel, spotDim);
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
        // Light: dark-ink fill scaled way down (0.25 base → ~0.055 ink) — a
        // soft gray panel, clearly visible on #fafafa (was white-on-white).
        // One scale constant, shared with the tint normalization below (same
        // pattern as borderBase) so a retune can't drift the two apart.
        const fillScale = isLight() ? 0.20 : 1;
        const fillAlphaActual = fillAlpha * fillScale;
        if (lc) {
          // Keep the TRUE layer hue in both modes (darkening it killed the
          // colour identity). Light mode just raises the rest alpha to ~the
          // old hover level, since a light-page tint at the dark-canvas alpha
          // was near-invisible. Dark: unchanged quiet hue.
          const tintFillAlpha = isLight()
            ? 0.08 * (fillAlpha / 0.25)
            : 0.032 * (fillAlphaActual / (0.25 * fillScale));
          ctx.fillStyle = rgbaStr(lc[0], lc[1], lc[2], tintFillAlpha);
        } else {
          ctx.fillStyle = rgbaStr(ff[0], ff[1], ff[2], fillAlphaActual);
        }
        ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);

        // Light mode gets a higher border floor (0.115 × 2.4 ≈ 0.28 idle): the
        // old 0.24 idle black read too faint against the light page. Pulled
        // down from ×3 so the pure-black neutral border sits at the same
        // perceived weight as the (lighter) coloured tint borders — black
        // reads heavier per unit alpha than a mid-lightness hue.
        const borderBase = isLight() ? 0.115 : 0.08;
        const baseBorderAlpha = borderBase + 0.15 * liveFx.frameHeat(frame.id, now);
        const focusBoost = isFocused ? 0.12 : 0;
        const hoverBorderBoost = hoverLevel * 0.2;
        const borderAlphaMult = isLight() ? 2.4 : 1;
        const borderAlpha = (baseBorderAlpha + focusBoost + hoverBorderBoost) * (1 - dimLevel * 0.5) * borderAlphaMult * alphaMul;

        const fb = frameBorderRGB();
        if (lc) {
          // True hue; light mode's rest alpha ≈ the old hover level (was 0.22).
          const tintBorderAlpha = isLight()
            ? Math.min(0.95, 0.58 * (borderAlpha / (borderBase * borderAlphaMult)))
            : 0.22 * (borderAlpha / (borderBase * borderAlphaMult));
          ctx.strokeStyle = rgbaStr(lc[0], lc[1], lc[2], tintBorderAlpha);
        } else {
          ctx.strokeStyle = rgbaStr(fb[0], fb[1], fb[2], borderAlpha);
        }
        ctx.lineWidth = isFocused ? 1.2 : 1;
        roundedRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h, 4);
        ctx.stroke();

        const isLabelHovered = hoveredLabelFrameId === frame.id;
        // Light mode labels sit a step brighter — 0.5 dark ink washed out on the light page.
        // Eased down from 0.66 to sit level with the coloured tint labels.
        const labelBase = isLight() ? 0.60 : 0.5;
        const labelAlpha = labelBase * (1 - dimLevel * 0.55) * alphaMul;
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
          // True hue; light mode's rest alpha ≈ the old hover level (was 0.55).
          const tintLabelAlpha = isLight()
            ? Math.min(1, 0.82 * (labelAlphaFinal / labelBase))
            : Math.min(1, 0.55 * (labelAlphaFinal / labelBase));
          ctx.fillStyle = `rgba(${lc[0]}, ${lc[1]}, ${lc[2]}, ${tintLabelAlpha})`;
        } else {
          ctx.fillStyle = `rgba(${pl[0]}, ${pl[1]}, ${pl[2]}, ${labelAlphaFinal})`;
        }
        ctx.fillText(pathText, -f.w / 2, primaryY);
      }

      // Presence heat — two tiers, drawn alongside (not replacing) the mutation
      // heat already folded into the border alpha above. Gated on showPresence
      // only, so it still reads with frames hidden; inert when no session has
      // touched this frame.
      //   TRAIL: faint thin outline, slow 90 s decay — the reload-backfill
      //          "where has work happened lately" trail. Drawn UNDER the flash.
      //   FLASH: prominent wide-border glow, fast 6 s decay — only the frame a
      //          session is CURRENTLY on / just arrived at. This is what fixes
      //          the "too many frames hot at once" storm.
      if (showPresence) {
        const ph = presenceFx.presenceHeat(String(frame.id), now);
        if (ph) {
          if (ph.trail > 0) {
            const [tr, tg, tb] = PRESENCE_COLORS[ph.trailColorIdx];
            ctx.strokeStyle = `rgba(${tr},${tg},${tb},${(PRESENCE_TRAIL_ALPHA * ph.trail).toFixed(3)})`;
            ctx.lineWidth = 1.5;
            roundedRect(ctx, -f.w / 2 - 1, -f.h / 2 - 1, f.w + 2, f.h + 2, 4.5);
            ctx.stroke();
          }
          if (ph.flash > 0) {
            const [pr, pg, pb] = PRESENCE_COLORS[ph.flashColorIdx];
            ctx.strokeStyle = `rgba(${pr},${pg},${pb},${(PRESENCE_FLASH_ALPHA * ph.flash).toFixed(3)})`;
            ctx.lineWidth = 2.5;
            roundedRect(ctx, -f.w / 2 - 2, -f.h / 2 - 2, f.w + 4, f.h + 4, 5);
            ctx.stroke();
          }
        }
      }

      ctx.restore();
    });
  }

  const marginaliaRects = [];

  /** Marginalia is its own top layer (drawn after edges + nodes in mainLoop)
   *  so pills and leader lines are never painted over by the edge web. */
  function drawMarginalia() {
    marginaliaRects.length = 0;
    if (!showDecisions && !showTodos) return;
    const fp = computeFocusProgress();
    if (fp.focused) {
      drawMarginaliaForFrame(fp.focused, fp.t);
    } else if (fp.from) {
      drawMarginaliaForFrame(fp.from, 1 - fp.t);
    }
  }

  // Locked marginalia pill width — long summaries truncate at the end (the
  // leading ID is the load-bearing part), so pills never run past the viewport.
  const MARGINALIA_MAX_W = 240;
  const MARGINALIA_PILL_H = 20;
  const MARGINALIA_GAP = 8;

  function drawMarginaliaForFrame(frameId, alphaMult) {
    // Invisible pills must not register hit rects — anything drawn here is
    // hoverable/clickable via marginaliaRects, so skip the fully-faded state.
    if (alphaMult <= 0.01) return;
    const frame = frameById.get(frameId);
    if (!frame) return;
    const decs = showDecisions ? getFrameDecisions(frameId) : [];
    const todos = showTodos ? getFrameTodos(frameId) : [];
    if (!decs.length && !todos.length) return;

    // The record whose drawer is currently open — its edges stay lit, like hover.
    const openDecId = (focusedRecord && focusedRecord.type === 'decision') ? focusedRecord.id : null;
    const openTodoId = (focusedRecord && focusedRecord.type === 'todo') ? focusedRecord.id : null;

    const f = framePx(frame);
    const pillH = MARGINALIA_PILL_H;
    const padX = 10;
    const markSize = 5;
    const markGap = 7;
    const maxTextW = MARGINALIA_MAX_W - padX * 2 - markSize - markGap;
    const startY = f.cy - f.h / 2 + 4;
    // Marginalia never extends below the frame's bottom edge: each column
    // shows what fits and folds the rest into a "View all" pill that opens
    // the records drawer scoped to this frame.
    const frameBottom = f.cy + f.h / 2;
    const capacity = Math.max(1, Math.floor((frameBottom - startY + MARGINALIA_GAP) / (pillH + MARGINALIA_GAP)));
    // Rows a column actually shows: everything if it fits, else reserve the
    // last slot for the View-all pill. Shared by both columns so their
    // overflow thresholds can never drift apart.
    const shownCount = (n) => (n <= capacity ? n : capacity - 1);

    const rightX = f.cx + f.w / 2 + 14;    // decisions column, grows rightward
    const leftEdgeX = f.cx - f.w / 2 - 14; // todos column, grows leftward

    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';

    let pillY = startY;
    const decShown = shownCount(decs.length);
    decs.slice(0, decShown).forEach((dec) => {
      const state = dec.state || 'active';
      const label = truncateEnd(ctx, `${decisionDisplayId(dec)} · ${dec.summary}`, maxTextW);
      const labelW = ctx.measureText(label).width;
      const pillW = padX + markSize + markGap + labelW + padX;
      const pillX = rightX;

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

      pillY += pillH + MARGINALIA_GAP;
    });
    if (decs.length > decShown) {
      drawViewAllPill('right', rightX, pillY, decs.length, 'decisions', frameId, alphaMult);
    }

    pillY = startY;
    const todoShown = shownCount(todos.length);
    todos.slice(0, todoShown).forEach((todo) => {
      const { rgb, ring } = todoDotColor(todo.state);
      const leaderColor = [250, 204, 21];
      const leaderAlpha = 0.2;

      const label = truncateEnd(ctx, `${todoDisplayId(todo)} · ${todo.summary}`, maxTextW);
      const labelW = ctx.measureText(label).width;
      const pillW = padX + markSize + markGap + labelW + padX;
      // Todos hang off the frame's LEFT edge (right-aligned column) so the
      // two record kinds don't compete for the same margin.
      const pillX = leftEdgeX - pillW;

      // Lit when hovered (via this pill OR the floating dot) OR when this todo's
      // drawer is open — keeps the marginalia leader edges highlighted.
      const isHovered = hoveredMarginaliaId === todo.id || hoveredTodoId === todo.id || openTodoId === todo.id;

      // Leader lines to anchor node dots — highlighted on hover. They leave
      // from the pill's RIGHT edge (the side facing the frame).
      const nodeIdxs = todo._nodeIdxs || [];
      nodeIdxs.forEach(idx => {
        const p = nodePx(nodes[idx]);
        ctx.strokeStyle = `rgba(${leaderColor[0]}, ${leaderColor[1]}, ${leaderColor[2]}, ${(isHovered ? 0.6 : leaderAlpha) * alphaMult})`;
        ctx.lineWidth = isHovered ? 1.2 : 0.6;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(pillX + pillW, pillY + pillH / 2);
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

      pillY += pillH + MARGINALIA_GAP;
    });
    if (todos.length > todoShown) {
      drawViewAllPill('left', leftEdgeX, pillY, todos.length, 'todos', frameId, alphaMult);
    }

    ctx.restore();
  }

  /** Overflow pill — "View all (N)". Clicking it opens the records drawer
   *  scoped to this frame (callbacks.onViewAll). Drawn in Sans: it's a button,
   *  not a record label. */
  function drawViewAllPill(side, anchorX, pillY, total, tab, frameId, alphaMult) {
    const pillH = MARGINALIA_PILL_H;
    const padX = 10;
    ctx.save(); // font switches to Sans here; restore() hands mono back to the caller
    ctx.font = '500 10px "Geist", sans-serif';
    const label = `View all (${total})`;
    const labelW = ctx.measureText(label).width;
    const pillW = padX + labelW + padX;
    const pillX = side === 'right' ? anchorX : anchorX - pillW;
    const id = `viewall:${tab}:${frameId}`;
    const isHovered = hoveredMarginaliaId === id;

    const bg = pillBgRGB();
    ctx.fillStyle = `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${(isHovered ? 1 : 0.85) * alphaMult})`;
    roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fill();

    const bd = frameBorderRGB();
    ctx.strokeStyle = `rgba(${bd[0]}, ${bd[1]}, ${bd[2]}, ${(isHovered ? 0.55 : 0.3) * alphaMult})`;
    ctx.lineWidth = 1;
    roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.stroke();

    const tx = pillTextRGB();
    ctx.fillStyle = `rgba(${tx[0]}, ${tx[1]}, ${tx[2]}, ${0.92 * alphaMult})`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pillX + padX, pillY + pillH / 2);
    ctx.restore();

    marginaliaRects.push({ type: 'viewall', id, tab, frameId, x: pillX, y: pillY, w: pillW, h: pillH });
  }

  // Bucket map reused across calls: keys are quantized alphas (≤ 32 of them),
  // so clearing + repopulating each drawEdges() call is cheap and avoids a
  // fresh Map allocation per frame.
  const _edgeBuckets = new Map();
  function drawEdges() {
    // Compute the max weight once so we can scale opacity. Falls back to 1
    // when all edges have unit weight (or none).
    let maxW = 1;
    for (const e of edges) {
      if (e.weight && e.weight > maxW) maxW = e.weight;
    }
    // Hoisted once per call (not per edge): inter-frame edges recede as the
    // camera zooms past fit, so zoomed-in reading stays local.
    const interZoomFade = interEdgeZoomFade(camera.zoom);
    const eb = edgeRGB(); // same ink for every edge this call — hoisted out of the loop

    // Pass 1: bucket visible edges by quantized alpha (1/32 steps). Same
    // culling (frame visibility + LOD) and same alpha computation as before;
    // quantizing only changes how many distinct strokeStyle values get used.
    _edgeBuckets.clear();
    edges.forEach((e) => {
      if (!visibleFrames.has(nodes[e.a].frameId) && !visibleFrames.has(nodes[e.b].frameId)) return;
      const la = lodByFrame.get(nodes[e.a].frameId);
      const lb = lodByFrame.get(nodes[e.b].frameId);
      const ra = la ? Math.max(0, Math.min(1, la.shown - nodes[e.a].revealRank)) : 1;
      const rb = lb ? Math.max(0, Math.min(1, lb.shown - nodes[e.b].revealRank)) : 1;
      const lodMul = Math.min(ra, rb) * detailShed;
      if (lodMul <= 0.01) return;
      // Inter-frame edges read at lower base alpha so they don't drown out
      // the local connectivity inside each frame. Then scale by sqrt(weight)
      // so a heavy CALLS relationship reads visibly heavier than a single
      // shared method.
      const baseAlpha = e.interFrame ? 0.09 : 0.15;
      const wScale = e.weight ? 0.4 + 0.6 * Math.sqrt(e.weight / maxW) : 1;
      const zoomFade = e.interFrame ? interZoomFade : 1;
      // Light mode needs more than a nudge: dark mode draws white on near-black
      // (the maximum contrast available), so the same alpha buys far less
      // separation against a #fafafa page. Calibrated with the darker edgeRGB
      // ink for PARITY with dark mode rather than raw boost — light now reads
      // 1.099 / 1.521 contrast at min/max edge weight against dark's 1.074 /
      // 1.509. Pushing further (2.0x measured 1.126 / 1.708) overshoots at the
      // heavy end and brings back the dominating edge web that put light mode on
      // a lighter ink in the first place.
      const alpha = baseAlpha * wScale * (isLight() ? 1.6 : 1) * lodMul * zoomFade;
      const q = quantizeAlpha(alpha);

      // Both endpoints alive at once (a and b), so drawEdges gets two scratch
      // objects. Their .x/.y are copied into the bucket's flat number array
      // immediately — nothing retains the scratch objects themselves.
      const a = nodePx(nodes[e.a], _edgeA);
      const b = nodePx(nodes[e.b], _edgeB);
      let seg = _edgeBuckets.get(q);
      if (!seg) _edgeBuckets.set(q, seg = []);
      seg.push(a.x, a.y, b.x, b.y);
    });

    // Pass 2: one memoized rgba() strokeStyle + one beginPath() + all
    // segments + one stroke() per bucket — caps the per-frame
    // strokeStyle/beginPath/stroke count at ≤32 instead of edge-count.
    // lineWidth is constant across every edge, so it's set once here, and
    // there is no save/restore at all: this function only ever sets
    // strokeStyle/lineWidth, which every other draw pass in mainLoop already
    // sets fresh before using.
    ctx.lineWidth = 0.6;
    for (const [q, seg] of _edgeBuckets) {
      ctx.strokeStyle = rgbaStr(eb[0], eb[1], eb[2], q);
      ctx.beginPath();
      for (let i = 0; i < seg.length; i += 4) {
        ctx.moveTo(seg[i], seg[i + 1]);
        ctx.lineTo(seg[i + 2], seg[i + 3]);
      }
      ctx.stroke();
    }
  }

  function findGoverningDecision(nodeIdx) {
    const n = nodes[nodeIdx];
    const decs = getFrameDecisions(n.frameId);
    for (const dec of decs) {
      if ((dec._nodeIdxs || []).includes(nodeIdx)) return dec;
    }
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
    const frame = frameById.get(n.frameId);
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
    const frame = frameById.get(n.frameId);
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

    // Hoisted: the per-node body below only ever sets fillStyle/strokeStyle/
    // lineWidth/font/textAlign/textBaseline before using them — no clip, no
    // transform — so one save/restore wraps the whole loop instead of two
    // pairs (dot + label) per node.
    ctx.save();
    nodes.forEach((n, i) => {
      if (!visibleFrames.has(n.frameId)) return;
      const lod = lodByFrame.get(n.frameId);
      const reveal = lod ? Math.max(0, Math.min(1, lod.shown - n.revealRank)) : 1;
      const detail = reveal * detailShed;
      if (detail <= 0.01) return; // skip un-revealed dots entirely
      const p = nodePx(n, _nodeDrawScratch);
      const frame = frameById.get(n.frameId);
      const inFocused = focusedId && frame?.id === focusedId;
      const sizeMult = inFocused ? 1 + 0.4 * fp.t : (fp.from && frame?.id === fp.from ? 1 + 0.4 * (1 - fp.t) : 1);
      const isAnchor = anchorNodeIdx === i && inFocused;
      const isHovered = hoveredNodeIdx === i;

      if (n.kind === 'decision') {
        ctx.fillStyle = rgbaStr(74, 222, 128, 0.85 * detail);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.8 * sizeMult, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const nb = nodeBaseRGB();
        ctx.fillStyle = rgbaStr(nb[0], nb[1], nb[2], 0.75 * detail);
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

      const la = (lod ? lod.label : 0) * detail;
      if (la > 0.02 && n.kind !== 'decision') {
        ctx.font = '400 9px "Geist Mono", monospace';
        const sl = subLabelRGB();
        ctx.fillStyle = `rgba(${sl[0]}, ${sl[1]}, ${sl[2]}, ${0.85 * la})`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(truncateEnd(ctx, n.name, 110), p.x + 5, p.y);
      }
    });
    ctx.restore();
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

  /** Prototype v5 `drawProviderGlyph` (claude branch) — the ✳-style asterisk
   *  the presence strip uses, drawn on the canvas. Four crossing strokes of
   *  radius 3.2 centered at (x, y) in the given ink. Presence sessions are all
   *  agent cursors, so only the claude glyph is ported here. */
  function drawClaudeGlyph(ctx, x, y, color, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 4;
      const r = 3.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * -r, Math.sin(a) * -r);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** End-truncation with ellipsis — for labels whose PREFIX carries the
   *  identity (marginalia: "D-12 · summary…"). Runs inside the rAF loop for
   *  every visible pill, so results are memoized: inputs are stable per label
   *  (fixed 10px mono font, constant MARGINALIA_MAX_W-derived width). Keyed on
   *  `ctx.font` (not just maxWidth+text): truncateEnd is called from two
   *  different font contexts sharing this cache (marginalia pills' 10px
   *  Geist Mono, drawNodes' 9px sub-labels) — measureText depends on
   *  whatever font is currently set, so a coincidental text+maxWidth match
   *  across those two contexts would otherwise silently serve a truncation
   *  measured at the wrong font. */
  const truncateCache = new Map();
  function truncateEnd(ctx, text, maxWidth) {
    const key = ctx.font + '|' + maxWidth + '|' + text;
    const hit = truncateCache.get(key);
    if (hit !== undefined) return hit;
    let out = '…';
    if (ctx.measureText(text).width <= maxWidth) {
      out = text;
    } else {
      for (let keep = text.length - 1; keep >= 1; keep--) {
        const candidate = text.slice(0, keep).trimEnd() + '…';
        if (ctx.measureText(candidate).width <= maxWidth) { out = candidate; break; }
      }
    }
    if (truncateCache.size > 500) truncateCache.clear(); // labels churn on live updates; keep it bounded
    truncateCache.set(key, out);
    return out;
  }

  /** Middle-truncation with ellipsis — for labels whose SUFFIX carries the
   *  identity (frame path labels: "…/deep/path/file.ts"). Same hot-loop
   *  shape as truncateEnd (every visible frame label, every tick a frame is
   *  drawn), so it's memoized the same way: bounded cache, size-guard 500.
   *  Shares truncateCache — the 'M|' prefix can't collide with truncateEnd's
   *  keys. Also keyed on `ctx.font` for the same reason truncateEnd is (see
   *  above) — cheap and correct since measureText already depends on it. */
  function truncateMiddle(ctx, text, maxWidth) {
    const key = 'M|' + ctx.font + '|' + maxWidth + '|' + text;
    const hit = truncateCache.get(key);
    if (hit !== undefined) return hit;
    let out = text;
    if (ctx.measureText(text).width > maxWidth) {
      out = '…';
      for (let keep = text.length - 1; keep >= 2; keep--) {
        const leftLen = Math.ceil(keep / 2);
        const rightLen = keep - leftLen;
        const candidate = text.slice(0, leftLen) + '…' + text.slice(text.length - rightLen);
        if (ctx.measureText(candidate).width <= maxWidth) { out = candidate; break; }
      }
    }
    if (truncateCache.size > 500) truncateCache.clear();
    truncateCache.set(key, out);
    return out;
  }

  /** Bounded memo for `rgba(r, g, b, a)` strings — HOT loops only (edge
   *  buckets, per-node dot fills, per-frame box strokes/fills), not a
   *  repo-wide rewrite of every template literal. Cleared wholesale past
   *  2000 entries rather than LRU'd — alpha churns continuously (hover/LOD/
   *  live-effect eases), so a bounded-and-cleared cache is simpler than
   *  eviction bookkeeping for the same steady-state hit rate. */
  const rgbaCache = new Map();
  function rgbaStr(r, g, b, a) {
    const k = ((r << 16) | (g << 8) | b) + '|' + a;
    let v = rgbaCache.get(k);
    if (v === undefined) {
      v = `rgba(${r}, ${g}, ${b}, ${a})`;
      if (rgbaCache.size > 2000) rgbaCache.clear();
      rgbaCache.set(k, v);
    }
    return v;
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
      // Uniform dot size — aggregates are not sized by member_count. Capped so
      // aggregate dots don't balloon past file dots at high zoom.
      const baseDotR = Math.min(AGG_DOT_R * v.scale, AGG_DOT_R * 1.6);
      const { nx, ny } = aggregateFraction(agg, i, AGGREGATES.length);
      // Same fit-to-content transform as frames so dots stay anchored to the cloud.
      // Aggregates don't drive the fit (computeViewTransform frames the cloud
      // only), so a dot the keep-out flung far out could map off-canvas — clamp
      // it back on-screen so it stays visible.
      const fitX = (nx * stageW) * v.scale + v.ox;
      const fitY = (ny * stageH) * v.scale + v.oy;
      // ...then the SAME focus displacement the frames take, so opening a frame
      // moves the aux dots with the rest of the canvas instead of stranding them
      // over the focused card.
      const fa = aggregatePx(fitX, fitY, baseDotR * 2);
      const dotR = fa.w / 2;
      const clampOn = isIdentity(camera) && !camAnim;
      const cx = clampOn ? Math.max(dotR + 4, Math.min(stageW - dotR - 4, fa.cx)) : fa.cx;
      const cy = clampOn ? Math.max(dotR + 4, Math.min(stageH - dotR - 4, fa.cy)) : fa.cy;

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

  // Canvas-px center of a frame, honoring the current camera + focus transform
  // (reuses framePx, the same camera-composed world→screen mapping drawFrames
  // uses, so presence cursors stay glued to their frame under pan/zoom). null
  // for unknown frames — presence data can name a frame that isn't in the
  // current project — and for frames culled off-viewport, so presence draws
  // stay consistent with main's viewport culling (a small fixed-cost overlay,
  // exempt from LOD dot-budget shedding but not from culling).
  function frameCenterPx(frameId) {
    const frame = FRAMES.find((f) => String(f.id) === String(frameId));
    if (!frame) return null;
    if (!visibleFrames.has(frame.id)) return null;
    const fp = framePx(frame);
    return { x: fp.cx, y: fp.cy };
  }

  // Is node `idx`'s dot currently drawn? Mirrors drawNodes' gating exactly
  // (frame visible + LOD reveal past its rank, scaled by the zoom detail shed),
  // so presence never targets a dot the graph isn't actually painting.
  function isDotDrawn(idx) {
    const n = nodes[idx];
    if (!n || !visibleFrames.has(n.frameId)) return false;
    const lod = lodByFrame.get(n.frameId);
    const reveal = lod ? Math.max(0, Math.min(1, lod.shown - n.revealRank)) : 1;
    return reveal * detailShed > 0.01;
  }

  // Canvas-px of a presence ref's dot within `frameId`, IF that dot is drawn at
  // the current LOD; else null (caller falls back to frame center). The path
  // must belong to the named frame — a stale targetPath never yields a dot.
  function dotPxIfDrawn(frameId, filePath) {
    if (!filePath) return null;
    const idx = PATH_TO_IDX.get(filePath);
    if (idx === undefined) return null;
    if (String(nodes[idx].frameId) !== String(frameId)) return null;
    if (!isDotDrawn(idx)) return null;
    return nodePx(nodes[idx]);
  }

  // A currently-drawn inter-frame edge between the two frames, oriented
  // from→to (a in fromFrameId, b in toFrameId), or null when none is drawn.
  // Lets a traversal synapse ride the real edge's geometry (prototype
  // drawSynapses) instead of a center-to-center straight line.
  function drawnInterFrameEdgePx(fromFrameId, toFrameId) {
    for (const e of edges) {
      if (!e.interFrame) continue;
      const fa = String(nodes[e.a].frameId), fb = String(nodes[e.b].frameId);
      let aIdx, bIdx;
      if (fa === String(fromFrameId) && fb === String(toFrameId)) { aIdx = e.a; bIdx = e.b; }
      else if (fa === String(toFrameId) && fb === String(fromFrameId)) { aIdx = e.b; bIdx = e.a; }
      else continue;
      if (!isDotDrawn(aIdx) || !isDotDrawn(bIdx)) continue;
      return { a: nodePx(nodes[aIdx]), b: nodePx(nodes[bIdx]) };
    }
    return null;
  }

  // Spotlight emphasis pulses — a looping bright head sliding from→to on each
  // emphasized pair while the spotlight holds. Editorial accent: neutral theme
  // ink (vs presence pulses, which carry session hues). Skipped entirely under
  // reducedMotion (the pair's frames are already spotlight-lit).
  const EMPHASIS_LOOP_MS = 1600;
  function drawSpotlightEmphasis(now) {
    if (!spotlight || !spotlight.emphasis?.length || reducedMotion) return;
    const BASE = isLight() ? [24, 24, 27] : [237, 237, 237];
    // Hoisted: no per-pair clip/transform below — strokeStyle/lineWidth/
    // fillStyle are all set fresh before each use — so one save/restore wraps
    // the whole loop instead of one pair per emphasis pair.
    ctx.save();
    spotlight.emphasis.forEach((pair, i) => {
      const edgePx = drawnInterFrameEdgePx(pair.from, pair.to);
      const a = edgePx ? edgePx.a : frameCenterPx(pair.from);
      const b = edgePx ? edgePx.b : frameCenterPx(pair.to);
      if (!a || !b) return;
      const t = ((now - spotlight.t0) / EMPHASIS_LOOP_MS + i * 0.35) % 1;
      const hx = a.x + (b.x - a.x) * t, hy = a.y + (b.y - a.y) * t;
      const TRAIL = 0.18;
      const tx = a.x + (b.x - a.x) * Math.max(0, t - TRAIL);
      const ty = a.y + (b.y - a.y) * Math.max(0, t - TRAIL);
      ctx.strokeStyle = `rgba(${BASE[0]},${BASE[1]},${BASE[2]},0.35)`;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${BASE[0]},${BASE[1]},${BASE[2]},0.8)`;
      ctx.fill();
    });
    ctx.restore();
  }

  // Presence layer draw: traversal synapse pulses + session cursors. Fully
  // gated on showPresence and inert when the roster is empty. Called last from
  // drawLiveEffects so it reads on top of the graph and live-effects chrome.
  function drawPresence(now) {
    if (!showPresence) return;
    const sessions = presenceFx.sessions(now);

    // Map each in-flight segment to its session hue so a traversal synapse
    // pulses in the moving session's color (synapses() carries no color).
    const segColor = new Map();
    for (const s of sessions) {
      if (s.seg) segColor.set(s.seg.fromFrameId + '>' + s.seg.toFrameId, s.colorIdx);
    }

    // Synapse pulses — a bright head sliding from→to with a short fading trail,
    // in the moving session's hue. When a real inter-frame edge between the two
    // frames is currently drawn, the pulse RIDES that edge's actual endpoint
    // geometry (prototype drawSynapses); otherwise it runs frame-center to
    // frame-center as a fallback.
    // Hoisted: no per-synapse clip/transform below, so one save/restore wraps
    // the whole loop instead of one pair per synapse pulse.
    ctx.save();
    for (const sy of presenceFx.synapses(now)) {
      const edgePx = drawnInterFrameEdgePx(sy.fromFrameId, sy.toFrameId);
      let a, b;
      if (edgePx) {
        a = edgePx.a; b = edgePx.b;
      } else {
        a = frameCenterPx(sy.fromFrameId);
        b = frameCenterPx(sy.toFrameId);
      }
      if (!a || !b) continue;
      const ci = segColor.get(sy.fromFrameId + '>' + sy.toFrameId) ?? 0;
      const [r, g, bl] = PRESENCE_COLORS[ci];
      const fade = 1 - sy.t;
      const hx = a.x + (b.x - a.x) * sy.t;
      const hy = a.y + (b.y - a.y) * sy.t;
      const TRAIL = 0.18; // trail spans this fraction of the segment behind the head
      const tx = a.x + (b.x - a.x) * Math.max(0, sy.t - TRAIL);
      const ty = a.y + (b.y - a.y) * Math.max(0, sy.t - TRAIL);
      ctx.strokeStyle = `rgba(${r},${g},${bl},${(0.5 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${bl},${(0.9 * fade).toFixed(3)})`;
      ctx.fill();
    }
    ctx.restore();

    // Session cursors — prototype v5 cursor treatment: a small breathing dot
    // whose color lerps from the neutral base ink toward the session hue by
    // `colorAmount` (1 while traversing, fading to 0 over ~3.5 s after arrival),
    // so a resting cursor cools to neutral. At rest the dot targets the ref's
    // actual DOT when that dot is currently drawn (dot-level approach); during
    // traversal it lerps along the active segment; when the dot is shed at low
    // zoom it falls back to the frame center (never a stale dot position).
    const BASE = isLight() ? [24, 24, 27] : [237, 237, 237];
    for (const s of sessions) {
      let px = null;
      if (s.seg) {
        const a = frameCenterPx(s.seg.fromFrameId);
        const b = frameCenterPx(s.seg.toFrameId);
        if (a && b) px = { x: a.x + (b.x - a.x) * s.seg.t, y: a.y + (b.y - a.y) * s.seg.t };
      } else if (s.frameId != null) {
        px = dotPxIfDrawn(s.frameId, s.targetPath) || frameCenterPx(s.frameId);
      }
      if (!px) continue;

      const hue = PRESENCE_COLORS[s.colorIdx];
      const cAmt = s.colorAmount ?? 0;
      const r = Math.round(BASE[0] + (hue[0] - BASE[0]) * cAmt);
      const g = Math.round(BASE[1] + (hue[1] - BASE[1]) * cAmt);
      const bl = Math.round(BASE[2] + (hue[2] - BASE[2]) * cAmt);
      const breath = 1 + 0.04 * Math.sin(now * 0.002 + s.colorIdx * 1.7);
      const idleMul = s.idle ? 0.5 : 1;
      const dotAlpha = (0.4 + cAmt * 0.55) * idleMul;

      ctx.save();
      ctx.translate(px.x, px.y);

      // Breathing cursor dot (colorAmount-cooled toward neutral at rest).
      ctx.beginPath();
      ctx.arc(0, 0, 3 * breath, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${bl},${dotAlpha.toFixed(3)})`;
      ctx.fill();

      // Name pill riding the cursor (prototype v5 `drawCursors` 1:1): a fully
      // rounded pill 11px right of the dot, vertically centered. Content = the
      // claude ✳ glyph + `@workspace`. The fill lerps from a neutral IDLE_GREY
      // toward the session hue by colorAmount, so at rest it cools to a quiet
      // grey pill (prototype persists at rest — it never fades out); text stays
      // near-black. The whole pill shares the cursor's idle dimming so an
      // idle-faded cursor carries a matching quiet pill.
      const IDLE_GREY = isLight() ? [161, 161, 170] : [82, 82, 91];
      const fillR = Math.round(IDLE_GREY[0] + (hue[0] - IDLE_GREY[0]) * cAmt);
      const fillG = Math.round(IDLE_GREY[1] + (hue[1] - IDLE_GREY[1]) * cAmt);
      const fillB = Math.round(IDLE_GREY[2] + (hue[2] - IDLE_GREY[2]) * cAmt);

      ctx.font = '500 10px "Geist Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const username = `@${s.workspace ?? ''}`;
      const labelW = ctx.measureText(username).width;
      const padX = 8;
      const glyphSize = 8;
      const glyphGap = 6;
      const pillH = 18;
      const pillW = padX + glyphSize + glyphGap + labelW + padX;
      const pillX = 11;
      const pillY = -pillH / 2;
      const contentColor = [15, 15, 15];

      ctx.globalAlpha = idleMul;
      ctx.fillStyle = `rgb(${fillR}, ${fillG}, ${fillB})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();
      drawClaudeGlyph(ctx, pillX + padX + glyphSize / 2, 0, contentColor, 1);
      ctx.fillStyle = `rgb(${contentColor[0]}, ${contentColor[1]}, ${contentColor[2]})`;
      ctx.fillText(username, pillX + padX + glyphSize + glyphGap, 0);
      ctx.globalAlpha = 1;

      ctx.restore();
    }
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

    drawSpotlightEmphasis(now);
    drawPresence(now);
  }

  let presenceTick = 0;
  let visibleFrames = new Set();
  // Margin covers content drawn OUTSIDE the frame box: marginalia pill columns
  // (≤ MARGINALIA_MAX_W + 14) and labels — a culled frame must not pop its pills.
  const CULL_MARGIN = 260;
  function computeVisibleFrames() {
    visibleFrames = new Set();
    const W = canvas.clientWidth, H = canvas.clientHeight;
    for (const fr of FRAMES) {
      const f = framePx(fr);
      if (f.cx + f.w / 2 + CULL_MARGIN > 0 && f.cx - f.w / 2 - CULL_MARGIN < W &&
          f.cy + f.h / 2 + CULL_MARGIN > 0 && f.cy - f.h / 2 - CULL_MARGIN < H) {
        visibleFrames.add(fr.id);
      }
    }
  }

  // ── Idle discipline (perf phase 1): the rAF heartbeat always runs, but the
  // ten draw passes execute only when something changed (needsDraw, set by
  // invalidate() from every discrete mutation) or an animation is mid-flight
  // (animating(now) consults each self-settling source). A missed invalidate
  // shows as a stale frame — when adding a mutation, add its invalidate().
  let needsDraw = true;
  function invalidate() { needsDraw = true; }

  function animating(now) {
    // Camera lerp (setCamera animate / fitToFrames / settle springs).
    if (camAnim) return true;
    // Layout morph: frames gliding between two index layouts after a re-index.
    // Self-settling — dropped once past its window so it can't hold the loop hot.
    if (layoutMorph) {
      if (morphActive(layoutMorph, now)) return true;
      layoutMorph = null;
    }
    // Focus / defocus frame transition.
    if ((focusedFrameId || previousFocusId) && now - focusT0 < FOCUS_DURATION) return true;
    // Record drawer open/close ease.
    if (now - recordDrawerT0 < RECORD_DRAWER_DURATION) return true;
    // Frame hover border/fill eases (an 'in' entry persists at level 1; the
    // window check lets it settle without keeping the loop hot).
    for (const id in frameHoverState) {
      const st = frameHoverState[id];
      if (st && now - st.t0 < Math.max(HOVER_IN_MS, HOVER_OUT_MS)) return true;
    }
    // Node hover pill/ring: delayed fade-in, then fade-out after leave.
    if (hoveredNodeIdx !== null && now - nodeHoverT0 < NODE_HOVER_DELAY + NODE_HOVER_IN_MS) return true;
    if (lastHoveredNodeIdx !== null && now - nodeHoverLeaveT0 < NODE_HOVER_OUT_MS) return true;
    // Pinned info-pill in/out eases (click-pinned hover pill).
    if (pinnedNodeIdx !== null && now - pinnedT0 < PIN_IN_MS) return true;
    if (lastPinnedNodeIdx !== null && now - pinnedLeavingT0 < PIN_OUT_MS) return true;
    // Decision id-pill expand/collapse eases (entries persist; window-gated).
    for (const id in decisionExpandState) {
      const st = decisionExpandState[id];
      if (now - st.t0 < Math.max(DECISION_EXPAND_IN_MS, DECISION_EXPAND_OUT_MS)) return true;
    }
    // LOD reveal glides — visible frames only (computeLod skips culled frames,
    // freezing their glide; a frozen off-viewport glide must not hold the loop
    // hot). Window check, not shown !== target: the FP lerp lands on
    // from + (target-from)*1, which need not compare equal to target.
    for (const fr of FRAMES) {
      if (!visibleFrames.has(fr.id)) continue;
      const st = frameReveal[fr.id];
      if (st && st.t0 !== 0 && now - st.t0 < REVEAL_MS) return true;
    }
    // Anchor-node ring pulses continuously while a focused frame holds one.
    if (anchorNodeIdx !== null && focusedFrameId !== null) return true;
    // Spotlight: dim-in ease, then looping emphasis pulses while held.
    if (spotlight) {
      if (now - spotlight.t0 < FOCUS_DURATION) return true;
      if (!reducedMotion && spotlight.emphasis?.length) return true;
    }
    // Live-change treatments (births/halos/leaders/heat/tombstones/pills).
    if (liveFx.isActive(now)) return true;
    // Presence cursors breathe continuously while a roster exists; synapse and
    // heat windows too. Gated on showPresence — nothing presence-related draws
    // while hidden, and re-enabling goes through setLayerPrefs → invalidate().
    if (showPresence && presenceFx.isActive(now)) return true;
    return false;
  }

  function mainLoop() {
    const now = performance.now();

    // Heartbeat work stays unconditional: idle/gone roster transitions age
    // without any inbound event, so poke the (throttled) roster callback
    // periodically to let them propagate to React even while draws are skipped.
    if ((presenceTick = (presenceTick + 1) % 60) === 0) scheduleRosterCallback();

    if (needsDraw || animating(now)) {
      needsDraw = false;
      // Full-store clear (not clientWidth): between a CSS resize and an
      // embedder's debounced backing-store realloc the store is larger than
      // the client box, and a clientWidth clear leaves stale columns on
      // shrink. clearRect runs under the DPR setTransform, so width/height in
      // user units over-clear — clamped and harmless.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      viewTransform = compose(computeViewTransform(), cameraNow(now));
      framePxCache.clear();
      computeVisibleFrames();
      computeLod(now);
      // Edges are the lowest layer — everything (frames, nodes, marginalia)
      // reads on top of the connectivity web, not under it.
      drawEdges();
      drawFrames(now);
      drawNodes(now);
      drawMarginalia();
      if (showDecisions) drawFloatingDecisionNodes(now);
      else decisionNodeRects.length = 0;
      if (showTodos) drawFloatingTodoNodes(now);
      else todoNodeRects.length = 0;
      drawAggregates(now);
      drawHoverPill(now);
      drawCompactHoverBadge(now);
      drawLiveEffects(now);
    }

    rafId = requestAnimationFrame(mainLoop);
  }

  let rafId = null;

  function start() {
    if (rafId !== null) return; // never double-schedule the loop
    resize();
    rafId = requestAnimationFrame(mainLoop);
  }

  function stop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function destroy() {
    stop();
    if (rosterTimer !== null) { clearTimeout(rosterTimer); rosterTimer = null; }
    // canvas listeners are on the canvas element itself; removing the canvas
    // from the DOM (React unmount) drops them. No window listeners remain.
  }

  return {
    setData,
    applyLiveChanges,
    applyPresence,
    applySpotlight,
    setLayerPrefs,
    getLayerPrefs: () => ({ showFrames, showDecisions, showTodos, layerTint: layersOn, showPresence }),
    focusFrame: (id) => { anchorNodeIdx = null; setFocus(id); },
    setActiveRecord,
    frameIdForFilePath: (p) => frameIdForPath(FRAME_PATH_INDEX, p),
    getActiveRecord: () => focusedRecord,
    getFocusedFrameId: () => focusedFrameId,
    getCamera: () => ({ ...camera }),
    setCamera,
    fitToFrames,
    // Request one draw pass on the next rAF tick. For embedder-side visual
    // state the engine can't observe — e.g. a theme flip re-resolving the
    // isLight() probe — and any future mutation without its own invalidate.
    invalidate,
    start,
    stop,
    resize,
    destroy,
  };
}

export { LAYER_RGB };
