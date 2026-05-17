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

  const AGENT = {
    a: { base: '#ededed', rgb: [237, 237, 237], name: 'rasmus',  provider: 'human',  isUser: true },
    b: { base: '#60a5fa', rgb: [96, 165, 250],  name: 'kai',     provider: 'claude' },
    c: { base: '#c084fc', rgb: [192, 132, 252], name: 'mira',    provider: 'codex' },
  };
  const WHITE = [237, 237, 237];

  function agentRGBFor(key) {
    if (key === 'a' && isLight()) return [24, 24, 27];
    if (key === 'b' && isLight()) return [37, 99, 235];
    if (key === 'c' && isLight()) return [124, 58, 237];
    return AGENT[key].rgb;
  }

  const FRAMES = [
    { id: 'viewer',    name: 'src/viewer',     x: 0.16, y: 0.30, w: 190, h: 140, count: 142 },
    { id: 'graph',     name: 'src/graph',      x: 0.40, y: 0.18, w: 170, h: 120, count: 87 },
    { id: 'events',    name: 'src/events',     x: 0.62, y: 0.42, w: 170, h: 135, count: 64 },
    { id: 'mcp',       name: 'src/mcp-server', x: 0.80, y: 0.70, w: 180, h: 115, count: 53 },
    { id: 'ws',        name: 'src/ws',         x: 0.51, y: 0.78, w: 140, h: 95,  count: 28 },
    { id: 'temporal',  name: 'src/temporal',   x: 0.38, y: 0.62, w: 165, h: 105, count: 0 },
  ];

  const NODE_CFG = {
    viewer:    { count: 8 },
    graph:     { count: 6 },
    events:    { count: 5 },
    mcp:       { count: 4 },
    ws:        { count: 3 },
    temporal:  { count: 4 },
  };

  const FILE_NAMES = {
    viewer: ['graph-viewer-2d.js','projection.js','layout.js','groups.js','colors.js','camera.js','transitions.js','shapes.js'],
    graph:  ['schema.ts','store.ts','query.ts','index.ts','migrate.ts','types.ts'],
    events: ['emitter.ts','dispatch.ts','capture.ts','stream.ts','types.ts'],
    mcp:    ['server.ts','tools.ts','handlers.ts','index.ts'],
    ws:     ['client.ts','session.ts','protocol.ts'],
    temporal: ['timeline.ts','ordering.ts','causality.ts','index.ts'],
  };

  const nodes = [];
  const edges = [];
  const adjacency = {};
  const synapses = [];
  const frameHeat = {};
  const agents = {};

  let focusedFrameId = null;
  let focusT0 = 0;
  const FOCUS_DURATION = 550;
  let previousFocusId = null;

  const DECISIONS = {
    'D-142': {
      id: 'D-142',
      summary: 'LOD band projection',
      state: 'active',
      problem: 'At high zoom the graph becomes unreadable — hundreds of nodes overlap, labels collide, structure is hard to scan. A naïve "show everything always" approach does not scale past ~50 nodes.',
      resolution: 'Introduce a banded LOD projection: below zoom 0.4, show only decisions and depth-2 directory supernodes. Below 1.0, add depth-3 directories. Below 2.0, files appear. Beyond that, everything renders. Aggregation rules collapse edges when endpoints are hidden.',
      rationale: 'Matches established canon of zoomable map viz (Google Maps, d3 force-collapse patterns). Keeps information density roughly constant across zoom levels — the canvas feels dense but never overwhelming.',
      alternatives: [
        { title: 'Semantic zoom only',   reason: 'Too complex — requires NLP clustering we do not have' },
        { title: 'Fish-eye lens',        reason: 'Disorienting, poor fit for exploratory navigation' },
        { title: 'Always show everything', reason: 'Confirmed unreadable at scale during pilot' },
      ],
      proposedBy: 'kai',
      proposedAt: '2026-03-14',
      governs: [
        { kind: 'frame',    id: 'viewer', label: 'src/viewer' },
        { kind: 'file',     path: 'src/viewer/projection.js' },
        { kind: 'function', path: 'src/viewer/projection.js', name: 'computeBand' },
        { kind: 'symbol',   path: 'src/viewer/projection.js', name: 'BAND_TABLE' },
      ],
      supersedes: null,
      supersededBy: null,
      relatedTo: [],
      dependsOn: [],
      introducedIn: { number: 389, title: 'Introduce LOD projection for zoom viewer', state: 'merged' },
      implementedBy: [
        { number: 389, title: 'Introduce LOD projection for zoom viewer', state: 'merged' },
        { number: 401, title: 'LOD band threshold tuning', state: 'merged' },
      ],
      challengedBy: [],
      discussedIn: [{ number: 389, title: 'Introduce LOD projection for zoom viewer', state: 'merged' }],
    },
    'D-087': {
      id: 'D-087',
      summary: 'territory hull overlay',
      state: 'superseded',
      problem: 'Governed regions of code needed a visual language — showing which nodes fall under which decision.',
      resolution: 'Draw convex hulls around nodes governed by the same decision. Tint faintly with a per-decision color.',
      rationale: 'Hulls make the governance territory visible at a glance without needing to trace edges.',
      alternatives: [
        { title: 'Per-node colored borders', reason: 'Too noisy when many decisions overlap' },
      ],
      proposedBy: 'rasmus',
      proposedAt: '2026-02-22',
      governs: [
        { kind: 'frame', id: 'viewer', label: 'src/viewer' },
        { kind: 'file',  path: 'src/viewer/groups.js' },
        { kind: 'function', path: 'src/viewer/groups.js', name: 'deriveTerritories' },
      ],
      supersedes: null,
      supersededBy: 'D-156',
      relatedTo: [],
      dependsOn: [],
      introducedIn: { number: 198, title: 'Territory hulls for governance visualization', state: 'merged' },
      implementedBy: [{ number: 198, title: 'Territory hulls for governance visualization', state: 'merged' }],
      challengedBy: [],
      discussedIn: [],
    },
    'D-156': {
      id: 'D-156',
      summary: 'governance as marginalia',
      state: 'active',
      problem: 'Territory hulls (D-087) became visually noisy at scale — overlapping hulls made it hard to see what governs what when decisions span many nodes.',
      resolution: 'Replace hulls with marginalia pills attached to the right edge of focused frames. Each decision that governs nodes in the frame appears as a small pill, with faint leader lines to the specific governed nodes.',
      rationale: 'Marginalia respects the document metaphor — annotations live at the edge, not on top of the content. Less visual overlap, more readable at scale.',
      alternatives: [
        { title: 'Keep hulls but dim them', reason: 'Did not solve the overlap problem at scale' },
        { title: 'Icon badges on each governed node', reason: 'Node-level chrome too small to be legible' },
      ],
      proposedBy: 'kai',
      proposedAt: '2026-04-02',
      governs: [
        { kind: 'frame',    id: 'viewer', label: 'src/viewer' },
        { kind: 'function', path: 'src/viewer/graph-viewer-2d.js', name: 'drawMarginaliaForFrame' },
      ],
      supersedes: 'D-087',
      supersededBy: null,
      relatedTo: ['D-142'],
      dependsOn: [],
      introducedIn: { number: 412, title: 'Replace territory hulls with marginalia', state: 'merged' },
      implementedBy: [{ number: 412, title: 'Replace territory hulls with marginalia', state: 'merged' }],
      challengedBy: [],
      discussedIn: [{ number: 412, title: 'Replace territory hulls with marginalia', state: 'merged' }],
    },
    'D-094': {
      id: 'D-094',
      summary: 'sqlite as graph store',
      state: 'active',
      problem: 'Needed a persistent store for the knowledge graph — nodes, edges, decisions, provenance — accessible to multiple agents.',
      resolution: 'SQLite via better-sqlite3, attached read-only from codebase-memory-mcp for structural code data, native tables for decisions and events.',
      rationale: 'Single-file, no server, cross-platform, fast for the workload. Attaching CBM read-only keeps code-structural data authoritative to that system while Cortex owns the decision graph.',
      alternatives: [
        { title: 'Neo4j',    reason: 'Operationally heavy for a personal MCP server' },
        { title: 'Postgres', reason: 'Overkill for single-user; server process required' },
        { title: 'DuckDB',   reason: 'Better at analytics, worse at graph-y queries' },
      ],
      proposedBy: 'rasmus',
      proposedAt: '2026-03-05',
      governs: [
        { kind: 'frame', id: 'graph', label: 'src/graph' },
        { kind: 'file',  path: 'src/graph/store.ts' },
        { kind: 'file',  path: 'src/graph/schema.ts' },
      ],
      supersedes: null,
      supersededBy: null,
      relatedTo: [],
      dependsOn: [],
      introducedIn: { number: 302, title: 'Graph storage on SQLite', state: 'merged' },
      implementedBy: [{ number: 302, title: 'Graph storage on SQLite', state: 'merged' }],
      challengedBy: [],
      discussedIn: [],
    },
    'D-103': {
      id: 'D-103',
      summary: 'ws event stream',
      state: 'stale',
      problem: 'Viewer needed to receive agent activity in real time — synapse firings, decision creations, presence updates.',
      resolution: 'WebSocket connection from viewer to MCP server. JSON events on a single channel. Reconnect with exponential backoff.',
      rationale: 'Bidirectional, low-latency, browser-native. Simpler than SSE + separate POST for client-to-server messages.',
      alternatives: [
        { title: 'Server-sent events', reason: 'One-way only, needed bidirectional' },
        { title: 'Polling', reason: 'Too slow for synapse animations' },
      ],
      proposedBy: 'kai',
      proposedAt: '2026-03-20',
      governs: [
        { kind: 'frame', id: 'events', label: 'src/events' },
        { kind: 'frame', id: 'ws',     label: 'src/ws' },
        { kind: 'file',  path: 'src/ws/client.ts' },
        { kind: 'file',  path: 'src/events/stream.ts' },
      ],
      supersedes: null,
      supersededBy: null,
      relatedTo: [],
      dependsOn: [],
      introducedIn: { number: 356, title: 'Initial ws event stream', state: 'merged' },
      implementedBy: [{ number: 356, title: 'Initial ws event stream', state: 'merged' }],
      challengedBy: [],
      discussedIn: [],
    },
    'D-167': {
      id: 'D-167',
      summary: 'causal ordering',
      state: 'proposed',
      problem: 'Decisions and synapses need a clear temporal order — when multiple agents act in overlapping code, we need to know what happened before what, not just wall-clock.',
      resolution: '(draft) Use Lamport timestamps per agent, combined with server receipt time as tiebreaker. Store both the logical clock and the wall-clock for every event.',
      rationale: '(draft) Lamport gives causal consistency without needing clock sync across agents. Wall-clock tiebreaker is honest about the fact that some events are genuinely concurrent.',
      alternatives: [
        { title: 'Vector clocks', reason: 'More precise but heavier per-event overhead' },
        { title: 'Wall clock only', reason: 'Breaks down when agents run on different machines' },
      ],
      proposedBy: 'mira',
      proposedAt: '2026-04-18',
      governs: [
        { kind: 'frame', id: 'temporal', label: 'src/temporal' },
      ],
      supersedes: null,
      supersededBy: null,
      relatedTo: [],
      dependsOn: [],
      introducedIn: null,
      implementedBy: [],
      challengedBy: [],
      discussedIn: [],
    },
    'D-201': {
      id: 'D-201',
      summary: 'structured logging across subsystems',
      state: 'active',
      problem: 'Debugging multi-agent sessions required correlating log entries across disparate subsystems (graph store, event bus, MCP transport). Plaintext console logging made cross-system causality hard to reconstruct after the fact.',
      resolution: 'All internal log events are emitted as structured JSON with required fields: ts, agent, subsystem, event, correlationId. Subsystems adopt a shared logger module that enforces the schema.',
      rationale: 'Shared schema lets tooling stitch multi-subsystem flows together. Correlation ID plumbed through MCP request context unifies traces from plugin invocation through graph write to event emission.',
      alternatives: [
        { title: 'OpenTelemetry', reason: 'Too heavy for a single-user MCP server; dependency footprint not justified yet' },
        { title: 'Per-subsystem logging', reason: 'What we had — correlation across systems was the exact pain point' },
      ],
      proposedBy: 'rasmus',
      proposedAt: '2026-03-28',
      governs: [
        { kind: 'frame', id: 'graph',  label: 'src/graph' },
        { kind: 'frame', id: 'events', label: 'src/events' },
        { kind: 'frame', id: 'mcp',    label: 'src/mcp-server' },
        { kind: 'file',  path: 'src/graph/store.ts' },
        { kind: 'file',  path: 'src/events/emitter.ts' },
        { kind: 'file',  path: 'src/mcp-server/handlers.ts' },
      ],
      supersedes: null,
      supersededBy: null,
      relatedTo: [],
      dependsOn: [],
      introducedIn: { number: 405, title: 'Structured logging rollout', state: 'merged' },
      implementedBy: [{ number: 405, title: 'Structured logging rollout', state: 'merged' }],
      challengedBy: [],
      discussedIn: [],
    },
  };

  const FRAME_GOVERNANCE = {
    viewer:    ['D-142', 'D-087', 'D-156'],
    graph:     ['D-094', 'D-201'],
    events:    ['D-103', 'D-201'],
    mcp:       ['D-201'],
    temporal:  ['D-167'],
  };

  const PRS = {
    '512': {
      number: 512,
      title: 'Introduce temporal/causal ordering subsystem',
      state: 'open',
      author: 'mira',
      openedAt: '2026-04-18',
      branch: 'feature/temporal-reasoning-with-causal-ordering',
      lastActivityAt: '2026-04-20',
      description: 'Adds a new src/temporal subsystem for establishing causal order across agent events. Required foundation for multi-agent sessions where wall-clock ordering is insufficient. Proposes D-167 as the governing decision — currently proposed and not yet ratified by code alignment.',
      touches: [
        { frameId: 'temporal', nodeName: 'timeline.ts',  action: 'added' },
        { frameId: 'temporal', nodeName: 'ordering.ts',  action: 'added' },
        { frameId: 'temporal', nodeName: 'causality.ts', action: 'added' },
        { frameId: 'temporal', nodeName: 'index.ts',     action: 'added' },
        { frameId: 'events',   nodeName: 'emitter.ts',   action: 'modified' },
        { frameId: 'events',   nodeName: 'dispatch.ts',  action: 'modified' },
        { frameId: 'ws',       nodeName: 'protocol.ts',  action: 'modified' },
      ],
      introducesFrame: 'temporal',
      introducesDecisions: ['D-167'],
      introducesDecision: 'D-167',
      referencesDecisions: ['D-103'],
      linkedPrs: [],
      additions: 12,
      commentCount: 4,
    },
    '389': {
      number: 389,
      title: 'Introduce LOD projection for zoom viewer',
      state: 'merged',
      author: 'kai',
      openedAt: '2026-03-14',
      mergedAt: '2026-03-17',
      description: 'Implements banded level-of-detail rendering in the zoom viewer. Establishes BAND_TABLE and computeBand() in projection.js. Validates D-142.',
      touches: [],
      introducesFrame: null,
      introducesDecisions: ['D-142'],
      referencesDecisions: [],
      linkedPrs: [401],
      additions: 0,
      commentCount: 12,
    },
    '412': {
      number: 412,
      title: 'Replace territory hulls with marginalia',
      state: 'merged',
      author: 'kai',
      openedAt: '2026-04-02',
      mergedAt: '2026-04-05',
      description: 'Supersedes D-087 (territory hulls) with D-156 (marginalia). Moves governance visualization from overlay hulls to edge-attached pills on focused frames.',
      touches: [],
      introducesFrame: null,
      introducesDecisions: ['D-156'],
      referencesDecisions: ['D-087'],
      linkedPrs: [],
      additions: 0,
      commentCount: 6,
    },
  };

  function getPr(id) { return PRS[String(id)]; }
  function prByNumber(num) { return PRS[String(num)] || null; }
  function activePrs() {
    return Object.values(PRS).filter(pr => pr.state === 'open' || pr.state === 'draft');
  }
  function getActivePRs() { return activePrs(); }
  function framesIntroducedByActivePRs() {
    const set = new Set();
    activePrs().forEach(pr => { if (pr.introducesFrame) set.add(pr.introducesFrame); });
    return set;
  }
  function isFrameUncommitted(frameId) {
    return framesIntroducedByActivePRs().has(frameId);
  }
  function getFrameActiveBranch(frameId) {
    for (const pr of activePrs()) {
      if (pr.introducesFrame === frameId) return pr.branch;
    }
    return null;
  }
  function getFrameAdditions(frameId) {
    let count = 0;
    for (const pr of activePrs()) {
      if (pr.introducesFrame === frameId) count += (pr.additions || 0);
    }
    return count;
  }
  function isNodeTouchedByActivePR(frameId, nodeName) {
    for (const pr of activePrs()) {
      for (const t of pr.touches) {
        if (t.frameId === frameId && t.nodeName === nodeName) return pr;
      }
    }
    return null;
  }
  function prsTouchingFrame(frameId) {
    return activePrs().filter(pr => pr.touches.some(t => t.frameId === frameId));
  }
  function prsTouchingNode(nodeIdx) {
    const n = nodes[nodeIdx];
    if (!n) return [];
    return activePrs().filter(pr => pr.touches.some(t => t.frameId === n.frameId && t.nodeName === n.name));
  }

  function getDecision(id) { return DECISIONS[id]; }
  function getFrameDecisions(frameId) {
    return (FRAME_GOVERNANCE[frameId] || []).map(getDecision).filter(Boolean);
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function buildGraph() {
    nodes.length = 0; edges.length = 0;
    Object.keys(adjacency).forEach(k => delete adjacency[k]);
    FRAMES.forEach(f => { frameHeat[f.id] = { agent: null, intensity: 0, t0: 0 }; });

    FRAMES.forEach(frame => {
      const cfg = NODE_CFG[frame.id];
      for (let i = 0; i < cfg.count; i++) {
        nodes.push({
          id: frame.id + '-' + i,
          frameId: frame.id,
          kind: i < cfg.decisions ? 'decision' : 'file',
          rx: rand(0.16, 0.84),
          ry: rand(0.22, 0.78),
          name: (FILE_NAMES[frame.id] || [])[i % (FILE_NAMES[frame.id]?.length || 1)] || 'n-' + i,
        });
        adjacency[nodes.length - 1] = [];
      }
    });

    function addEdge(a, b, interFrame) {
      const edge = { a, b, intensity: 0, interFrame };
      edges.push(edge);
      adjacency[a].push({ to: b, edge: edges.length - 1 });
      adjacency[b].push({ to: a, edge: edges.length - 1 });
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[i].frameId === nodes[j].frameId && Math.random() < 0.45) {
          addEdge(i, j, false);
        }
      }
    }

    const byFrame = {};
    nodes.forEach((n, i) => { (byFrame[n.frameId] ||= []).push(i); });
    const frameIds = Object.keys(byFrame);
    for (let a = 0; a < frameIds.length; a++) {
      for (let b = a + 1; b < frameIds.length; b++) {
        if (Math.random() < 0.6) {
          const p1 = byFrame[frameIds[a]];
          const p2 = byFrame[frameIds[b]];
          addEdge(p1[Math.floor(Math.random() * p1.length)], p2[Math.floor(Math.random() * p2.length)], true);
        }
      }
    }

    Object.keys(adjacency).forEach(i => {
      if (adjacency[i].length === 0) {
        const cands = nodes.map((_, j) => j).filter(j => j != i);
        const pick = cands[Math.floor(Math.random() * cands.length)];
        addEdge(+i, pick, nodes[i].frameId !== nodes[pick].frameId);
      }
    });

    for (const frameId in FRAME_GOVERNANCE) {
      const frameNodes = nodes.map((n, i) => ({ n, i })).filter(o => o.n.frameId === frameId);
      const decIds = FRAME_GOVERNANCE[frameId];
      decIds.forEach((decId) => {
        const dec = DECISIONS[decId];
        if (!dec) return;
        const targetCount = Math.min(2 + Math.floor(Math.random() * 2), frameNodes.length);
        const shuffled = [...frameNodes].sort(() => Math.random() - 0.5);
        dec._nodeIdxs = shuffled.slice(0, targetCount).map(o => o.i);
      });
    }
  }

  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function computeFocusProgress() {
    if (!focusedFrameId && !previousFocusId) return { t: 0, focused: null, from: null };
    const dt = performance.now() - focusT0;
    const raw = Math.min(1, dt / FOCUS_DURATION);
    const t = ease(raw);
    return { t, focused: focusedFrameId, from: previousFocusId };
  }

  function framePxBase(frame) {
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    return {
      cx: Math.max(frame.w / 2 + 40, Math.min(stageW - frame.w / 2 - 40, frame.x * stageW)),
      cy: Math.max(frame.h / 2 + 40, Math.min(stageH - frame.h / 2 - 50, frame.y * stageH)),
      w: frame.w, h: frame.h,
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

    const pad = 40;
    newCx = Math.max(compressedW / 2 + pad, Math.min(stageW - compressedW / 2 - pad, newCx));
    newCy = Math.max(compressedH / 2 + pad, Math.min(stageH - compressedH / 2 - pad, newCy));

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
  let hoveredPrNumber = null;
  let hoveredDecisionId = null;
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
  }

  function openDecisionCard(decId) { openRecord('decision', decId); }
  function openPrCard(prId) { openRecord('pr', prId); }
  function closeDecisionCard() { closeRecord(); }
  function currentDecisionId() {
    return focusedRecord && focusedRecord.type === 'decision' ? focusedRecord.id : null;
  }

  const frameHoverState = {};

  const MERGE_DURATION = 2400;
  const MERGE_BEATS = {
    IGNITE:    [0,    300],
    BORDER:    [300,  900],
    NODE_FILL: [600,  1200],
    EDGE_SET:  [900,  1400],
    COUNTER:   [1200, 1600],
    DECISION:  [1600, 2000],
    PR_SETTLE: [2000, 2400],
  };
  const activeMerges = {};

  function startMerge(prNumber) {
    const pr = PRS[String(prNumber)];
    if (!pr || pr.state !== 'open') return;
    if (activeMerges[prNumber]) return;

    const touchedOrder = [];
    const byFrame = {};
    pr.touches.forEach(t => {
      (byFrame[t.frameId] ||= []).push(t.nodeName);
    });
    Object.keys(byFrame).forEach((frameId, fi) => {
      byFrame[frameId].forEach((nodeName, ni) => {
        touchedOrder.push({ frameId, nodeName, bfsIndex: fi + ni });
      });
    });

    const now = performance.now();
    const touchedFrameSet = new Set();
    pr.touches.forEach(t => touchedFrameSet.add(t.frameId));
    if (pr.introducesFrame) touchedFrameSet.add(pr.introducesFrame);

    edges.forEach((e, idx) => {
      if (!e.interFrame) return;
      const frameA = nodes[e.a].frameId;
      const frameB = nodes[e.b].frameId;
      if (touchedFrameSet.has(frameA) && touchedFrameSet.has(frameB)) {
        synapses.push({ edgeIdx: idx, t0: now + Math.random() * 80, duration: 580 });
      }
    });

    activeMerges[prNumber] = {
      prNumber,
      t0: now,
      duration: MERGE_DURATION,
      touchedOrder,
      startCounter: getFrameAdditions(pr.introducesFrame) || pr.additions || 0,
      decisionRatified: false,
    };

    const btn = document.getElementById('merge-btn');
    if (btn) btn.disabled = true;
  }

  function mergeForPr(prNumber) {
    return activeMerges[String(prNumber)] || activeMerges[prNumber] || null;
  }

  function activeMergeForFrame(frameId) {
    for (const key in activeMerges) {
      const m = activeMerges[key];
      const pr = PRS[String(m.prNumber)];
      if (!pr) continue;
      if (pr.touches.some(t => t.frameId === frameId)) return m;
      if (pr.introducesFrame === frameId) return m;
    }
    return null;
  }

  function activeMergeForNode(frameId, nodeName) {
    for (const key in activeMerges) {
      const m = activeMerges[key];
      const pr = PRS[String(m.prNumber)];
      if (!pr) continue;
      const touch = pr.touches.find(t => t.frameId === frameId && t.nodeName === nodeName);
      if (touch) return { merge: m, action: touch.action };
    }
    return null;
  }

  function tickMerges(now) {
    for (const key in activeMerges) {
      const m = activeMerges[key];
      const elapsed = now - m.t0;
      if (elapsed >= m.duration) {
        const pr = PRS[String(m.prNumber)];
        if (pr) {
          pr.state = 'merged';
          pr.mergedAt = new Date().toISOString().slice(0, 10);
          if (pr.introducesDecisions && pr.introducesDecisions.length) {
            pr.introducesDecisions.forEach(decId => {
              const dec = DECISIONS[decId];
              if (dec && dec.state === 'proposed') dec.state = 'active';
            });
          }
          if (pr.introducesFrame) {
            const frame = FRAMES.find(f => f.id === pr.introducesFrame);
            if (frame) {
              const framePrNodes = nodes.filter(n => n.frameId === frame.id && n.kind !== 'decision');
              frame.count = framePrNodes.length + (pr.additions || 0);
            }
          }
        }
        delete activeMerges[key];
        const btn = document.getElementById('merge-btn');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'merged · reload to reset';
        }
      }
    }
  }

  function mergeBeatProgress(merge, beatName, now) {
    if (!merge) return 0;
    const elapsed = now - merge.t0;
    const [start, end] = MERGE_BEATS[beatName];
    if (elapsed < start) return 0;
    if (elapsed >= end) return 1;
    return (elapsed - start) / (end - start);
  }

  function decisionRatifyProgress(decId, now) {
    for (const key in activeMerges) {
      const m = activeMerges[key];
      const pr = PRS[String(m.prNumber)];
      if (!pr) continue;
      if (pr.introducesDecisions && pr.introducesDecisions.includes(decId)) {
        return ease(mergeBeatProgress(m, 'DECISION', now));
      }
    }
    return 0;
  }
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
      const touching = isNodeTouchedByActivePR(n.frameId, n.name);
      const addedNode = touching && touching.touches.find(t => t.frameId === n.frameId && t.nodeName === n.name)?.action === 'added';
      const baseR = n.kind === 'decision' ? 2.8 : (addedNode ? 2.4 : 2.2);
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
    const labelFrame = marginaliaHit ? null : frameLabelAtPoint(px, py);
    const bodyFrame = marginaliaHit ? null : frameAtPoint(px, py);

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

    const prHover = prNodeAtPoint(px, py);
    hoveredPrNumber = prHover ? prHover.number : null;

    const decHover = decisionNodeAtPoint(px, py);
    hoveredDecisionId = decHover ? decHover.id : null;

    if (prHover || decHover) {
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
    hoveredPrNumber = null;
    hoveredDecisionId = null;
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
    const frame = frameAtPoint(px, py);
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
        const hitId = marginaliaHit.type === 'pr' ? String(marginaliaHit.prNumber) : marginaliaHit.id;
        if (focusedRecord.type === marginaliaHit.type && String(focusedRecord.id) === hitId) {
          closeRecord();
        } else {
          openRecord(marginaliaHit.type, hitId);
        }
        return;
      }
      const prHit = prNodeAtPoint(px, py);
      if (prHit) {
        openRecord('pr', String(prHit.number));
        return;
      }
      const decHit = decisionNodeAtPoint(px, py);
      if (decHit) {
        openRecord('decision', decHit.id);
        return;
      }
      closeRecord();
      return;
    }

    const marginaliaHit = marginaliaAtPoint(px, py);
    if (marginaliaHit) {
      const hitId = marginaliaHit.type === 'pr' ? String(marginaliaHit.prNumber) : marginaliaHit.id;
      openRecord(marginaliaHit.type, hitId);
      return;
    }

    const prHit = prNodeAtPoint(px, py);
    if (prHit) {
      openRecord('pr', String(prHit.number));
      return;
    }

    const decHit = decisionNodeAtPoint(px, py);
    if (decHit) {
      openRecord('decision', decHit.id);
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

    const labelFrame = frameLabelAtPoint(px, py);
    if (labelFrame) {
      anchorNodeIdx = null;
      setFocus(labelFrame.id === focusedFrameId ? null : labelFrame.id);
      return;
    }

    if (focusedFrameId) {
      const bodyFrame = frameAtPoint(px, py);
      if (!bodyFrame || bodyFrame.id !== focusedFrameId) {
        anchorNodeIdx = null;
        setFocus(null);
      }
    }
  });

  function bfsPath(startIdx, endIdx) {
    if (startIdx === endIdx) return [startIdx];
    const visited = new Set([startIdx]);
    const queue = [[startIdx, [startIdx]]];
    while (queue.length) {
      const [cur, path] = queue.shift();
      for (const { to } of adjacency[cur]) {
        if (visited.has(to)) continue;
        if (to === endIdx) return [...path, to];
        visited.add(to);
        queue.push([to, [...path, to]]);
      }
    }
    return [startIdx];
  }

  function findEdge(a, b) {
    return adjacency[a].find(x => x.to === b)?.edge;
  }

  function chooseNextTarget(agentKey) {
    const ag = agents[agentKey];
    const curIdx = ag.nodeIdx;
    const reach = [];
    for (const { to } of adjacency[curIdx]) {
      for (const { to: t2 } of adjacency[to]) {
        if (t2 !== curIdx && !reach.includes(t2)) reach.push(t2);
      }
      if (!reach.includes(to)) reach.push(to);
    }
    if (!reach.length) return curIdx;
    return reach[Math.floor(Math.random() * reach.length)];
  }

  function beginTraversal(agentKey, targetIdx) {
    const ag = agents[agentKey];
    if (ag.traversing) return;
    const path = bfsPath(ag.nodeIdx, targetIdx);
    if (path.length < 2) return;
    ag.traversing = true;
    ag.path = path;
    ag.pathStep = 0;
    ag.segmentT0 = performance.now();
    ag.segmentDuration = 580;

    const firstEdge = findEdge(path[0], path[1]);
    if (firstEdge != null) {
      synapses.push({ edgeIdx: firstEdge, t0: performance.now(), duration: 580 });
    }

    const targetNode = nodes[targetIdx];
    frameHeat[targetNode.frameId] = { agent: agentKey, intensity: 1, t0: performance.now() };
  }

  function advanceAgents(now) {
    for (const key in agents) {
      const ag = agents[key];

      if (ag.traversing) {
        const elapsed = now - ag.segmentT0;
        const t = Math.min(1, elapsed / ag.segmentDuration);
        const fromIdx = ag.path[ag.pathStep];
        const toIdx = ag.path[ag.pathStep + 1];
        const fromP = nodePx(nodes[fromIdx]);
        const toP = nodePx(nodes[toIdx]);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        ag.x = fromP.x + (toP.x - fromP.x) * ease;
        ag.y = fromP.y + (toP.y - fromP.y) * ease;

        if (t >= 1) {
          ag.pathStep++;
          ag.nodeIdx = toIdx;
          ag.arrivedAt = now;
          const tgt = nodes[toIdx];
          if (frameHeat[tgt.frameId].agent !== key) {
            frameHeat[tgt.frameId] = { agent: key, intensity: 0.9, t0: now };
          }

          if (ag.pathStep >= ag.path.length - 1) {
            ag.traversing = false;
            ag.restUntil = now + 1200 + Math.random() * 800;
          } else {
            const nextEdge = findEdge(ag.path[ag.pathStep], ag.path[ag.pathStep + 1]);
            if (nextEdge != null) {
              synapses.push({ edgeIdx: nextEdge, t0: now, duration: 580 });
            }
            ag.segmentT0 = now;
            ag.segmentDuration = 580;
          }
        }
      }

      if (ag.traversing) {
        ag.colorAmount = 1;
      } else {
        const sinceArrival = now - (ag.arrivedAt || 0);
        ag.colorAmount = Math.max(0, 1 - sinceArrival / 3500);
      }
    }
  }

  const prNodeRects = [];
  const prExpandState = {};
  const PR_EXPAND_IN_MS = 160;
  const PR_EXPAND_OUT_MS = 200;

  function prExpandLevel(prNumber, targetExpanded, now) {
    const key = String(prNumber);
    const s = prExpandState[key] || { level: 0, direction: 'out', t0: 0 };
    const nowTarget = targetExpanded ? 'in' : 'out';
    if (s.direction !== nowTarget) {
      s.startLevel = s.level;
      s.direction = nowTarget;
      s.t0 = now;
    }
    const dur = nowTarget === 'in' ? PR_EXPAND_IN_MS : PR_EXPAND_OUT_MS;
    const p = Math.min(1, (now - s.t0) / dur);
    const eased = ease(p);
    const target = nowTarget === 'in' ? 1 : 0;
    const start = s.startLevel ?? s.level;
    s.level = start + (target - start) * eased;
    prExpandState[key] = s;
    return s.level;
  }

  function drawFloatingPRNodes(now) {
    prNodeRects.length = 0;
    const activePRList = activePrs();
    if (!activePRList.length) return;

    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';

    const selectedPrNumber = (focusedRecord && focusedRecord.type === 'pr') ? String(focusedRecord.id) : null;

    activePRList.forEach(pr => {
      const touchedPositions = [];
      pr.touches.forEach(t => {
        nodes.forEach(n => {
          if (n.frameId === t.frameId && n.name === t.nodeName) {
            touchedPositions.push(nodePx(n));
          }
        });
      });
      if (!touchedPositions.length) return;

      let cx = touchedPositions.reduce((s, p) => s + p.x, 0) / touchedPositions.length;
      let cy = touchedPositions.reduce((s, p) => s + p.y, 0) / touchedPositions.length;

      const touchingFrames = new Set(pr.touches.map(t => t.frameId));
      let dotX = cx, dotY = cy;
      let tries = 0;
      const dotBoxR = 14;
      while (tries < 16) {
        let overlap = false;
        for (const frame of FRAMES) {
          if (touchingFrames.has(frame.id)) continue;
          if (isFrameUncommitted(frame.id)) continue;
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

      const prState = pr.state;
      const dotColor =
        prState === 'merged' ? [79, 70, 229] :
        prState === 'draft'  ? [100, 116, 139] :
                               [129, 140, 248];

      const prMerge = activeMerges[String(pr.number)];
      const settleP = prMerge ? ease(mergeBeatProgress(prMerge, 'PR_SETTLE', now)) : 0;
      const alpha = 1 - settleP;
      if (alpha <= 0.01) return;

      const isSelected = selectedPrNumber === String(pr.number);
      const isHovered = hoveredPrNumber === pr.number;
      const focusTouches = focusedFrameId && touchingFrames.has(focusedFrameId);
      const pillVisible = isHovered || isSelected || focusTouches || !!prMerge;
      const expand = prExpandLevel(pr.number, pillVisible, now);

      const DOT_R = 4;
      const HIT_R = 14;

      const showLeaders = isSelected || !!prMerge;
      if (showLeaders) {
        touchedPositions.forEach(p => {
          ctx.strokeStyle = `rgba(129, 140, 248, ${0.22 * alpha})`;
          ctx.lineWidth = 0.6;
          ctx.setLineDash(prState === 'draft' ? [2, 3] : [2, 2]);
          ctx.beginPath();
          ctx.moveTo(dotX, dotY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
      } else if (expand > 0.001) {
        touchedPositions.forEach(p => {
          ctx.strokeStyle = `rgba(129, 140, 248, ${0.14 * alpha * expand})`;
          ctx.lineWidth = 0.6;
          ctx.setLineDash(prState === 'draft' ? [2, 3] : [2, 2]);
          ctx.beginPath();
          ctx.moveTo(dotX, dotY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }

      if (prState === 'draft') {
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.95 * alpha})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R - 0.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.95 * alpha})`;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }

      if (isSelected) {
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.5 * alpha})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      let pillRect = null;
      if (expand > 0.001) {
        const label = `#${pr.number}`;
        const titleLabel = truncateMiddle(ctx, pr.title, 200);
        const labelW = ctx.measureText(label).width;
        const titleW = ctx.measureText(titleLabel).width;
        const pillH = 22;
        const padX = 10;
        const gap = 8;
        const pillW = padX + labelW + gap + titleW + padX;

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

        const pillAlpha = alpha * expand;
        const fpBg = pillBgRGB();
        const fpText = prTextRGB();
        const fpTextSecondary = pillTextRGB();

        ctx.fillStyle = `rgba(${fpBg[0]}, ${fpBg[1]}, ${fpBg[2]}, ${0.96 * pillAlpha})`;
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.fill();

        ctx.strokeStyle = `rgba(129, 140, 248, ${(prState === 'draft' ? 0.4 : 0.55) * pillAlpha})`;
        ctx.lineWidth = 1;
        if (prState === 'draft') ctx.setLineDash([3, 2.5]);
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = `rgba(${fpText[0]}, ${fpText[1]}, ${fpText[2]}, ${0.98 * pillAlpha})`;
        ctx.textAlign = 'left';
        ctx.fillText(label, pillX + padX, pillY + pillH / 2);

        ctx.fillStyle = `rgba(${fpTextSecondary[0]}, ${fpTextSecondary[1]}, ${fpTextSecondary[2]}, ${0.85 * pillAlpha})`;
        ctx.fillText(titleLabel, pillX + padX + labelW + gap, pillY + pillH / 2);

        pillRect = { x: pillX, y: pillY, w: pillW, h: pillH };
      }

      prNodeRects.push({
        number: pr.number,
        x: dotX - HIT_R, y: dotY - HIT_R, w: HIT_R * 2, h: HIT_R * 2,
        pillRect,
        cx: dotX, cy: dotY,
      });
    });

    ctx.restore();
  }

  function prNodeAtPoint(px, py) {
    for (const r of prNodeRects) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
      if (r.pillRect) {
        const p = r.pillRect;
        if (px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h) return r;
      }
    }
    return null;
  }

  const decisionNodeRects = [];
  const decisionExpandState = {};

  function decisionExpandLevel(decId, target, now) {
    const s = decisionExpandState[decId] || { level: 0, direction: 'out', t0: 0 };
    const want = target ? 'in' : 'out';
    if (s.direction !== want) {
      s.startLevel = s.level;
      s.direction = want;
      s.t0 = now;
    }
    const dur = want === 'in' ? PR_EXPAND_IN_MS : PR_EXPAND_OUT_MS;
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
          const match = FRAMES.find(f => g.path === f.name || g.path.startsWith(f.name + '/'));
          if (match) governedFrameIds.add(match.id);
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
          if (isFrameUncommitted(frame.id)) continue;
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

      const isSelected = selectedDecId === dec.id;
      const isHovered = hoveredDecisionId === dec.id;
      const focusTouches = focusedFrameId && governedFrameIds.has(focusedFrameId);
      const pillVisible = isHovered || isSelected || focusTouches;
      const expand = decisionExpandLevel(dec.id, pillVisible, now);

      const DOT_R = 4;
      const HIT_R = 14;

      const showLeaders = isSelected;
      if (showLeaders) {
        governedPositions.forEach(p => {
          ctx.strokeStyle = `rgba(74, 222, 128, 0.22)`;
          ctx.lineWidth = 0.6;
          ctx.setLineDash(state === 'proposed' ? [2, 3] : [2, 2]);
          ctx.beginPath();
          ctx.moveTo(dotX, dotY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
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

      const dotFillAlpha = state === 'proposed' ? 0.42 : 0.95;
      ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${dotFillAlpha})`;
      ctx.beginPath();
      ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
      ctx.fill();

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
        const label = dec.id;
        const titleLabel = truncateMiddle(ctx, dec.summary, 220);
        const labelW = ctx.measureText(label).width;
        const titleW = ctx.measureText(titleLabel).width;
        const pillH = 22;
        const padX = 10;
        const gap = 8;
        const pillW = padX + labelW + gap + titleW + padX;

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

        ctx.fillStyle = `rgba(${pillTextRGB()[0]}, ${pillTextRGB()[1]}, ${pillTextRGB()[2]}, ${0.85 * pillAlpha * stateFade})`;
        ctx.fillText(titleLabel, pillX + padX + labelW + gap, pillY + pillH / 2);

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

  function drawFrames(now) {
    marginaliaRects.length = 0;
    const fp = computeFocusProgress();
    const hasFocus = !!(fp.focused || (fp.from && fp.t < 1));
    const sharpFrameId = fp.focused;

    FRAMES.forEach(frame => {
      const f = framePx(frame);
      const heat = frameHeat[frame.id];
      const heatI = heat.intensity;
      const uncommitted = isFrameUncommitted(frame.id);
      const isFocused = frame.id === sharpFrameId;

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

      const baseFillAlpha = uncommitted
        ? 0.15 * (1 - dimLevel * 0.5)
        : 0.25 * (1 - dimLevel * 0.4);
      const fillAlpha = baseFillAlpha + hoverLevel * 0.18;
      const ff = frameFillRGB();
      const fillAlphaActual = isLight() ? fillAlpha * 0.45 : fillAlpha;
      ctx.fillStyle = `rgba(${ff[0]}, ${ff[1]}, ${ff[2]}, ${fillAlphaActual})`;
      ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);

      const baseBorderAlpha = uncommitted
        ? (0.14 + heatI * 0.18)
        : (0.08 + heatI * 0.15);
      const focusBoost = isFocused ? 0.12 : 0;
      const hoverBorderBoost = hoverLevel * 0.2;
      const borderAlphaMult = isLight() ? 3.0 : 1;
      const borderAlpha = (baseBorderAlpha + focusBoost + hoverBorderBoost) * (1 - dimLevel * 0.5) * borderAlphaMult;

      const merge = uncommitted ? activeMergeForFrame(frame.id) : null;
      const borderP = merge ? mergeBeatProgress(merge, 'BORDER', now) : 0;
      const easedBorderP = ease(borderP);
      const fb = frameBorderRGB();

      if (uncommitted && merge) {
        ctx.strokeStyle = `rgba(${fb[0]}, ${fb[1]}, ${fb[2]}, ${borderAlpha * (1 - easedBorderP)})`;
        ctx.lineWidth = isFocused ? 1.2 : 1;
        ctx.setLineDash([4, 3]);
        roundedRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h, 4);
        ctx.stroke();
        ctx.setLineDash([]);

        const solidAlpha = (0.08 + heatI * 0.15 + focusBoost + hoverBorderBoost) * (1 - dimLevel * 0.5) * borderAlphaMult;
        ctx.strokeStyle = `rgba(${fb[0]}, ${fb[1]}, ${fb[2]}, ${solidAlpha * easedBorderP})`;
        ctx.lineWidth = isFocused ? 1.2 : 1;
        roundedRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h, 4);
        ctx.stroke();
      } else {
        ctx.strokeStyle = `rgba(${fb[0]}, ${fb[1]}, ${fb[2]}, ${borderAlpha})`;
        ctx.lineWidth = isFocused ? 1.2 : 1;
        if (uncommitted) ctx.setLineDash([4, 3]);
        roundedRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h, 4);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const isLabelHovered = hoveredLabelFrameId === frame.id;
      const labelAlpha = (0.5 + heatI * 0.35) * (1 - dimLevel * 0.55);
      const hoverBoost = isLabelHovered ? (1 - labelAlpha) * 0.85 : 0;
      const labelAlphaFinal = Math.min(1, labelAlpha + hoverBoost);
      const primaryY = uncommitted ? -f.h / 2 - 21 : -f.h / 2 - 7;
      const subY = -f.h / 2 - 7;

      if (uncommitted) {
        ctx.textBaseline = 'alphabetic';
        const gap = 8;

        const counterP = merge ? mergeBeatProgress(merge, 'COUNTER', now) : 0;
        const easedCounterP = ease(counterP);
        const settleP = merge ? mergeBeatProgress(merge, 'PR_SETTLE', now) : 0;
        const easedSettleP = ease(settleP);

        const rawAdditions = getFrameAdditions(frame.id);
        const baseAdditions = merge ? merge.startCounter : rawAdditions;
        const additions = merge
          ? Math.max(0, Math.round(baseAdditions * (1 - easedCounterP)))
          : rawAdditions;
        const branchName = getFrameActiveBranch(frame.id) || '';

        ctx.font = '500 10px "Geist Mono", monospace';
        ctx.textAlign = 'right';
        const countText = `+${additions}`;
        const countW = ctx.measureText(countText).width;
        const countAlpha = (isLabelHovered ? 0.95 : 0.75 * (1 - dimLevel * 0.55)) * (1 - easedSettleP);
        const add = additionsRGB();
        ctx.fillStyle = `rgba(${add[0]}, ${add[1]}, ${add[2]}, ${countAlpha})`;
        ctx.fillText(countText, f.w / 2, primaryY);

        ctx.textAlign = 'left';
        const leftBudget = f.w - countW - gap;
        const pathText = truncateMiddle(ctx, frame.name, leftBudget);
        const pl = primaryLabelRGB();
        ctx.fillStyle = `rgba(${pl[0]}, ${pl[1]}, ${pl[2]}, ${labelAlphaFinal})`;
        ctx.fillText(pathText, -f.w / 2, primaryY);

        ctx.font = '400 9px "Geist Mono", monospace';
        const glyph = '\u2387';
        const glyphW = ctx.measureText(glyph + ' ').width;
        const bg = branchGlyphRGB();
        ctx.fillStyle = `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${labelAlphaFinal * (1 - easedSettleP)})`;
        ctx.fillText(glyph, -f.w / 2, subY);

        const branchBudget = f.w - glyphW;
        const branchText = truncateMiddle(ctx, branchName, branchBudget);
        const branchAlpha = (isLabelHovered ? 0.9 : 0.6 * (1 - dimLevel * 0.5)) * (1 - easedSettleP);
        const sub = subLabelRGB();
        ctx.fillStyle = `rgba(${sub[0]}, ${sub[1]}, ${sub[2]}, ${branchAlpha})`;
        ctx.fillText(branchText, -f.w / 2 + glyphW, subY);
      } else {
        ctx.textBaseline = 'alphabetic';
        const gap = 8;

        ctx.font = '10px "Geist Mono", monospace';
        ctx.textAlign = 'right';
        const countText = String(frame.count);
        const countW = ctx.measureText(countText).width;
        if (isLabelHovered) {
          const pl = primaryLabelRGB();
          ctx.fillStyle = `rgba(${pl[0]}, ${pl[1]}, ${pl[2]}, 0.95)`;
        } else {
          const ci = countIdleRGB();
          ctx.fillStyle = `rgba(${ci[0]}, ${ci[1]}, ${ci[2]}, ${0.85 * (1 - dimLevel * 0.55)})`;
        }
        ctx.fillText(countText, f.w / 2, primaryY);

        ctx.font = '500 10px "Geist Mono", monospace';
        ctx.textAlign = 'left';
        const leftBudget = f.w - countW - gap;
        const pathText = truncateMiddle(ctx, frame.name, leftBudget);
        const pl = primaryLabelRGB();
        ctx.fillStyle = `rgba(${pl[0]}, ${pl[1]}, ${pl[2]}, ${labelAlphaFinal})`;
        ctx.fillText(pathText, -f.w / 2, primaryY);
      }

      ctx.restore();
    });

    if (sharpFrameId) {
      drawMarginaliaForFrame(sharpFrameId, fp.t);
    } else if (fp.from) {
      drawMarginaliaForFrame(fp.from, 1 - fp.t);
    }
  }

  const marginaliaRects = [];

  function drawMarginaliaForFrame(frameId, alphaMult) {
    const frame = FRAMES.find(f => f.id === frameId);
    if (!frame) return;
    const decs = getFrameDecisions(frameId);
    if (!decs.length) return;

    const f = framePx(frame);
    const pillX = f.cx + f.w / 2 + 14;
    let pillY = f.cy - f.h / 2 + 4;

    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';

    decs.forEach((dec) => {
      const rawState = dec.state || 'active';
      const ratifyP = rawState === 'proposed' ? decisionRatifyProgress(dec.id, performance.now()) : 0;
      const state = ratifyP >= 1 ? 'active' : rawState;
      const label = `${dec.id} · ${dec.summary}`;
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

      const ratifyPulse = ratifyP > 0 && ratifyP < 1
        ? Math.sin(ratifyP * Math.PI)
        : 0;

      const nodeIdxs = dec._nodeIdxs || [];
      nodeIdxs.forEach(idx => {
        const p = nodePx(nodes[idx]);
        ctx.strokeStyle = `rgba(${leaderColor[0]}, ${leaderColor[1]}, ${leaderColor[2]}, ${(leaderAlpha + ratifyPulse * 0.4) * alphaMult})`;
        ctx.lineWidth = 0.6;
        ctx.setLineDash(state === 'proposed' ? [2, 3] : [2, 2]);
        ctx.beginPath();
        ctx.moveTo(pillX, pillY + pillH / 2);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      const isHovered = hoveredMarginaliaId === dec.id;
      const bgAlpha = (isHovered ? 1 : 0.85) * alphaMult * stateAlpha;
      const mpBg = pillBgGreenRGB();
      ctx.fillStyle = `rgba(${mpBg[0]}, ${mpBg[1]}, ${mpBg[2]}, ${bgAlpha})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();

      if (ratifyPulse > 0) {
        ctx.save();
        ctx.fillStyle = `rgba(74, 222, 128, ${0.12 * ratifyPulse})`;
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.strokeStyle = `rgba(${borderColor[0]}, ${borderColor[1]}, ${borderColor[2]}, ${(borderAlpha + (isHovered ? 0.2 : 0) + ratifyPulse * 0.3) * alphaMult})`;
      ctx.lineWidth = 1;
      if (state === 'proposed' && ratifyP < 0.5) ctx.setLineDash([3, 2.5]);
      else if (state === 'proposed' && ratifyP < 1) {
        const dashMix = 1 - (ratifyP - 0.5) * 2;
        ctx.setLineDash([3 + (1 - dashMix) * 20, 2.5 * dashMix + 0.01]);
      }
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (state === 'stale') {
        ctx.fillStyle = `rgba(245, 158, 11, ${0.9 * alphaMult})`;
        ctx.fillRect(pillX + 1, pillY + 4, 2, pillH - 8);
      }

      const markCx = pillX + padX + markSize / 2;
      const markCy = pillY + pillH / 2;
      if (state === 'proposed' && ratifyP < 0.6) {
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.9 * alphaMult})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(markCx, markCy, markSize / 2, 0, Math.PI * 2);
        ctx.stroke();
        if (ratifyP > 0) {
          ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.9 * alphaMult * (ratifyP / 0.6)})`;
          ctx.beginPath();
          ctx.arc(markCx, markCy, (markSize / 2) * (ratifyP / 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
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

    const prs = prsTouchingFrame(frameId);
    if (prs.length) {
      pillY += 6;
      prs.forEach((pr) => {
        const prMerge = activeMerges[String(pr.number)];
        const settleP = prMerge ? ease(mergeBeatProgress(prMerge, 'PR_SETTLE', performance.now())) : 0;
        const prAlpha = 1 - settleP;
        if (prAlpha <= 0.01) return;

        const label = `#${pr.number} · ${pr.title}`;
        const labelW = Math.min(ctx.measureText(label).width, 220);
        const pillH = 20;
        const padX = 10;
        const markSize = 5;
        const markGap = 7;
        const pillW = padX + markSize + markGap + labelW + padX;

        const prState = pr.state;
        const dotColor =
          prState === 'merged' ? [79, 70, 229] :
          prState === 'draft'  ? [100, 116, 139] :
          prState === 'closed' ? [71, 85, 105] :
                                 [129, 140, 248];
        const borderColor = [129, 140, 248];
        const borderAlpha = prState === 'draft' ? 0.35 : 0.45;
        const leaderAlpha = 0.18;

        const touchedNodeIdxs = [];
        pr.touches.forEach(t => {
          if (t.frameId !== frameId) return;
          nodes.forEach((n, idx) => {
            if (n.frameId === frameId && n.name === t.nodeName) touchedNodeIdxs.push(idx);
          });
        });

        touchedNodeIdxs.forEach(idx => {
          const p = nodePx(nodes[idx]);
          ctx.strokeStyle = `rgba(129, 140, 248, ${leaderAlpha * alphaMult * prAlpha})`;
          ctx.lineWidth = 0.6;
          ctx.setLineDash(prState === 'draft' ? [2, 3] : [2, 2]);
          ctx.beginPath();
          ctx.moveTo(pillX, pillY + pillH / 2);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });

        const isHovered = hoveredMarginaliaId === `pr-${pr.number}`;
        const bgAlpha = (isHovered ? 1 : 0.85) * alphaMult * prAlpha;
        const prmBg = pillBgRGB();
        const prmText = prTextRGB();
        ctx.fillStyle = `rgba(${prmBg[0]}, ${prmBg[1]}, ${prmBg[2]}, ${bgAlpha})`;
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.fill();

        ctx.strokeStyle = `rgba(${borderColor[0]}, ${borderColor[1]}, ${borderColor[2]}, ${(borderAlpha + (isHovered ? 0.2 : 0)) * alphaMult * prAlpha})`;
        ctx.lineWidth = 1;
        if (prState === 'draft') ctx.setLineDash([3, 2.5]);
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.stroke();
        ctx.setLineDash([]);

        const markCx = pillX + padX + markSize / 2;
        const markCy = pillY + pillH / 2;
        if (prState === 'draft') {
          ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.9 * alphaMult * prAlpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(markCx, markCy, markSize / 2, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.95 * alphaMult * prAlpha})`;
          ctx.beginPath();
          ctx.arc(markCx, markCy, markSize / 2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(pillX + padX + markSize + markGap, pillY, labelW, pillH);
        ctx.clip();
        ctx.fillStyle = `rgba(${prmText[0]}, ${prmText[1]}, ${prmText[2]}, ${0.95 * alphaMult * prAlpha})`;
        ctx.textAlign = 'left';
        ctx.font = '500 10px "Geist Mono", monospace';
        ctx.fillText(label, pillX + padX + markSize + markGap, pillY + pillH / 2);
        ctx.restore();

        marginaliaRects.push({
          type: 'pr',
          id: `pr-${pr.number}`,
          prNumber: pr.number,
          x: pillX, y: pillY, w: pillW, h: pillH,
          frameId,
        });

        pillY += pillH + 8;
      });
    }

    ctx.restore();
  }

  function drawEdges() {
    const now = performance.now();
    edges.forEach((e) => {
      const a = nodePx(nodes[e.a]);
      const b = nodePx(nodes[e.b]);
      const restAlpha = e.interFrame ? 0.09 : 0.15;
      const boost = Math.min(1, e.intensity);

      const frameA = nodes[e.a].frameId;
      const frameB = nodes[e.b].frameId;
      const touchesUncommitted = isFrameUncommitted(frameA) || isFrameUncommitted(frameB);

      const mergeA = activeMergeForFrame(frameA);
      const mergeB = activeMergeForFrame(frameB);
      const edgeMerge = mergeA || mergeB;
      const edgeSetP = edgeMerge ? ease(mergeBeatProgress(edgeMerge, 'EDGE_SET', now)) : 0;

      ctx.save();
      const alpha = ((touchesUncommitted ? restAlpha * 0.85 : restAlpha) + boost * 0.55) * (isLight() ? 2.2 : 1);
      const eb = frameBorderRGB();
      ctx.strokeStyle = `rgba(${eb[0]}, ${eb[1]}, ${eb[2]}, ${alpha})`;
      ctx.lineWidth = 0.6 + boost * 0.3;
      if (touchesUncommitted && boost < 0.2 && edgeSetP < 1) {
        const dashGap = 2.5 * (1 - edgeSetP) + 0.01;
        const dashLen = 3 + edgeSetP * 20;
        ctx.setLineDash([dashLen, dashGap]);
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      e.intensity *= 0.93;
    });
  }

  function drawSynapses(now) {
    for (let i = synapses.length - 1; i >= 0; i--) {
      const s = synapses[i];
      const t = (now - s.t0) / s.duration;
      if (t >= 1.05) { synapses.splice(i, 1); continue; }
      const edge = edges[s.edgeIdx];
      if (!edge) { synapses.splice(i, 1); continue; }

      const peak = 1 - Math.abs(t - 0.5) * 2;
      edge.intensity = Math.max(edge.intensity, peak);
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

  function findRecentToucher(nodeIdx) {
    let best = null, bestAmt = 0;
    for (const key in agents) {
      const ag = agents[key];
      if (!ag) continue;
      if (ag.nodeIdx === nodeIdx && ag.colorAmount > bestAmt) {
        bestAmt = ag.colorAmount;
        best = key;
      }
    }
    return best ? { key: best, amt: bestAmt } : null;
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
    const touching = isNodeTouchedByActivePR(n.frameId, n.name);
    const addedNode = touching && touching.touches.find(t => t.frameId === n.frameId && t.nodeName === n.name)?.action === 'added';
    const baseR = n.kind === 'decision' ? 2.8 : (addedNode ? 2.4 : 2.2);
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
      : (isFrameUncommitted(frame?.id) ? 'staged · ' + frame.name : 'file · ' + (frame?.name ?? ''));
    lines.push({
      text: kindLabel,
      color: `rgba(${SUB_RGB[0]}, ${SUB_RGB[1]}, ${SUB_RGB[2]}, ${0.95 * pillAlpha})`,
      size: 10, weight: 400,
    });

    const toucher = findRecentToucher(pillNodeIdx);
    if (toucher) {
      const info = AGENT[toucher.key];
      const rgb = info.rgb;
      const agentTextRgb = isLight()
        ? [Math.round(rgb[0] * 0.8), Math.round(rgb[1] * 0.8), Math.round(rgb[2] * 0.8)]
        : [Math.round(rgb[0] * 0.55), Math.round(rgb[1] * 0.55), Math.round(rgb[2] * 0.55)];
      const verb = toucher.amt > 0.7 ? 'here now' : 'touched recently';
      lines.push({
        text: `@${info.name} ${verb}`,
        color: info.isUser
          ? `rgba(${TEXT_RGB[0]}, ${TEXT_RGB[1]}, ${TEXT_RGB[2]}, ${0.95 * pillAlpha})`
          : `rgba(${agentTextRgb[0]}, ${agentTextRgb[1]}, ${agentTextRgb[2]}, ${0.95 * pillAlpha})`,
        size: 10, weight: 500,
      });
    }

    const gov = findGoverningDecision(pillNodeIdx);
    if (gov) {
      const govTextRgb = isLight() ? [134, 239, 172] : [22, 101, 52];
      lines.push({
        text: `under ${gov.id} · ${gov.summary}`,
        color: `rgba(${govTextRgb[0]}, ${govTextRgb[1]}, ${govTextRgb[2]}, ${0.95 * pillAlpha})`,
        size: 10, weight: 500,
      });
    }

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

    let pillX = p.x + 14;
    let pillY = p.y + 14;
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    if (pillX + pillW > stageW - 8) pillX = p.x - pillW - 14;
    if (pillY + pillH > stageH - 8) pillY = p.y - pillH - 14;
    if (pillX < 8) pillX = 8;
    if (pillY < 8) pillY = 8;

    ctx.save();

    const hpbg = hoverPillBgRGB();
    if (pinnedNodeIdx === pillNodeIdx) {
      ctx.save();
      ctx.shadowColor = `rgba(0, 0, 0, ${(isLight() ? 0.18 : 0.28) * pillAlpha})`;
      ctx.shadowBlur = isLight() ? 10 : 6;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = `rgba(${hpbg[0]}, ${hpbg[1]}, ${hpbg[2]}, ${0.97 * pillAlpha})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, 6);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = `rgba(${hpbg[0]}, ${hpbg[1]}, ${hpbg[2]}, ${0.97 * pillAlpha})`;
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

  function drawNodes(now) {
    const fp = computeFocusProgress();
    const focusedId = fp.focused;

    nodes.forEach((n, i) => {
      const p = nodePx(n);
      const frame = FRAMES.find(f => f.id === n.frameId);
      const frameUncommitted = isFrameUncommitted(frame?.id);
      const touchingPR = isNodeTouchedByActivePR(n.frameId, n.name);
      const nodeAction = touchingPR ? touchingPR.touches.find(t => t.frameId === n.frameId && t.nodeName === n.name)?.action : null;
      const isAdded = nodeAction === 'added';
      const isModified = nodeAction === 'modified';
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
        let touched = 0, touchedBy = null;
        for (const key in agents) {
          const ag = agents[key];
          if (!ag) continue;
          if (ag.nodeIdx === i && ag.colorAmount > 0) {
            if (ag.colorAmount > touched) { touched = ag.colorAmount; touchedBy = key; }
          }
        }

        let mergeFillP = 0;
        let modifiedRingFadeP = 0;
        if (touchingPR) {
          const mergeHere = activeMergeForNode(n.frameId, n.name);
          if (mergeHere) {
            const bfs = mergeHere.merge.touchedOrder.findIndex(
              o => o.frameId === n.frameId && o.nodeName === n.name
            );
            const baseP = mergeBeatProgress(mergeHere.merge, 'NODE_FILL', now);
            const elapsed = now - mergeHere.merge.t0;
            const beatStart = MERGE_BEATS.NODE_FILL[0];
            const beatEnd = MERGE_BEATS.NODE_FILL[1];
            const stagger = bfs >= 0 ? bfs * 60 : 0;
            const nodeStart = beatStart + stagger;
            const nodeEnd = Math.min(beatEnd, nodeStart + 300);
            if (elapsed < nodeStart) {
              mergeFillP = 0;
            } else if (elapsed >= nodeEnd) {
              mergeFillP = 1;
            } else {
              mergeFillP = (elapsed - nodeStart) / (nodeEnd - nodeStart);
            }
            mergeFillP = ease(mergeFillP);
            modifiedRingFadeP = mergeFillP;
          }
        }

        if (isAdded) {
          const hb = isLight() ? [105, 105, 115] : [140, 140, 145];
          let r = hb[0], g = hb[1], b = hb[2];
          if (touched > 0.05 && touchedBy) {
            const c = agentRGBFor(touchedBy);
            r = Math.round(r + (c[0] - r) * touched * 0.7);
            g = Math.round(g + (c[1] - g) * touched * 0.7);
            b = Math.round(b + (c[2] - b) * touched * 0.7);
          }
          if (mergeFillP > 0) {
            const baseSolid = nodeBaseRGB();
            const finalR = Math.round(r + (baseSolid[0] - r) * mergeFillP);
            const finalG = Math.round(g + (baseSolid[1] - g) * mergeFillP);
            const finalB = Math.round(b + (baseSolid[2] - b) * mergeFillP);
            ctx.fillStyle = `rgba(${finalR}, ${finalG}, ${finalB}, ${0.75 + mergeFillP * 0.13})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, (2.4 - mergeFillP * 0.2) * sizeMult, 0, Math.PI * 2);
            ctx.fill();

            if (mergeFillP < 1) {
              ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.9 * (1 - mergeFillP)})`;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.arc(p.x, p.y, 2.4 * sizeMult, 0, Math.PI * 2);
              ctx.stroke();
            }

            if (mergeFillP > 0.3 && mergeFillP < 0.85) {
              const pulseI = Math.sin((mergeFillP - 0.3) / 0.55 * Math.PI);
              const pulseRGB = frameBorderRGB();
              ctx.strokeStyle = `rgba(${pulseRGB[0]}, ${pulseRGB[1]}, ${pulseRGB[2]}, ${0.35 * pulseI})`;
              ctx.lineWidth = 0.8;
              ctx.beginPath();
              ctx.arc(p.x, p.y, (3.4 + pulseI * 1.5) * sizeMult, 0, Math.PI * 2);
              ctx.stroke();
            }
          } else {
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.4 * sizeMult, 0, Math.PI * 2);
            ctx.stroke();
          }
        } else if (isModified) {
          const nb = nodeBaseRGB();
          let r = nb[0], g = nb[1], b = nb[2];
          if (touched > 0.05 && touchedBy) {
            const c = agentRGBFor(touchedBy);
            r = Math.round(r + (c[0] - r) * touched * 0.6);
            g = Math.round(g + (c[1] - g) * touched * 0.6);
            b = Math.round(b + (c[2] - b) * touched * 0.6);
          }
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.88)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.2 * sizeMult, 0, Math.PI * 2);
          ctx.fill();

          const ringAlpha = 0.65 * (1 - modifiedRingFadeP);
          if (ringAlpha > 0.01) {
            ctx.strokeStyle = `rgba(129, 140, 248, ${ringAlpha})`;
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, (4.2 - modifiedRingFadeP * 0.8) * sizeMult, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        } else if (touched > 0.05 && touchedBy) {
          const c = agentRGBFor(touchedBy);
          const base = nodeBaseRGB();
          const r = Math.round(base[0] + (c[0] - base[0]) * touched * 0.6);
          const g = Math.round(base[1] + (c[1] - base[1]) * touched * 0.6);
          const b = Math.round(base[2] + (c[2] - base[2]) * touched * 0.6);
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.88)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.2 * sizeMult, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const nb = nodeBaseRGB();
          ctx.fillStyle = `rgba(${nb[0]}, ${nb[1]}, ${nb[2]}, 0.75)`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.9 * sizeMult, 0, Math.PI * 2);
          ctx.fill();
        }
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
        const baseR = n.kind === 'decision' ? 2.8 : (isAdded ? 2.4 : 2.2);
        ctx.arc(p.x, p.y, baseR * sizeMult + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    });
  }

  function drawProviderGlyph(ctx, x, y, provider, color, alpha) {
    ctx.save();
    ctx.translate(x, y);
    if (provider === 'claude') {
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
    } else if (provider === 'codex') {
      ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 - Math.PI / 2;
        const px = Math.cos(a) * 3.4;
        const py = Math.sin(a) * 3.4;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCursors(now) {
    for (const key in agents) {
      const ag = agents[key];
      if (!ag || ag.x == null) continue;
      const info = AGENT[key];
      const cAmt = info.isUser ? 1 : ag.colorAmount;
      const rgb = agentRGBFor(key);
      const BASE = isLight() ? [24, 24, 27] : WHITE;
      const IDLE_GREY = isLight() ? [161, 161, 170] : [82, 82, 91];

      let r, g, b;
      if (info.isUser) {
        r = BASE[0]; g = BASE[1]; b = BASE[2];
      } else {
        r = Math.round(BASE[0] + (rgb[0] - BASE[0]) * cAmt);
        g = Math.round(BASE[1] + (rgb[1] - BASE[1]) * cAmt);
        b = Math.round(BASE[2] + (rgb[2] - BASE[2]) * cAmt);
      }

      const breath = 1 + 0.04 * Math.sin(now * 0.002 + (key === 'a' ? 0 : key === 'b' ? 2 : 4));

      ctx.save();
      ctx.translate(ag.x, ag.y);

      const dotAlpha = info.isUser ? 0.95 : 0.4 + cAmt * 0.55;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${dotAlpha})`;
      ctx.beginPath();
      ctx.arc(0, 0, 3 * breath, 0, Math.PI * 2);
      ctx.fill();

      if (info.isUser) {
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.55)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.font = '500 10px "Geist Mono", monospace';
      const username = `@${info.name}`;
      const labelW = ctx.measureText(username).width;
      const glyphGap = 6;
      const padX = 8;
      const glyphSize = 8;
      const pillH = 18;
      const hasGlyph = !info.isUser;
      const pillW = padX + (hasGlyph ? glyphSize + glyphGap : 0) + labelW + padX;
      const pillX = 11;
      const pillY = -pillH / 2;

      let fillR, fillG, fillB;
      if (info.isUser) {
        fillR = BASE[0]; fillG = BASE[1]; fillB = BASE[2];
      } else {
        fillR = Math.round(IDLE_GREY[0] + (rgb[0] - IDLE_GREY[0]) * cAmt);
        fillG = Math.round(IDLE_GREY[1] + (rgb[1] - IDLE_GREY[1]) * cAmt);
        fillB = Math.round(IDLE_GREY[2] + (rgb[2] - IDLE_GREY[2]) * cAmt);
      }

      ctx.fillStyle = `rgba(${fillR}, ${fillG}, ${fillB}, 1)`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();

      const contentColor = info.isUser
        ? (isLight() ? [250, 250, 250] : [15, 15, 15])
        : [15, 15, 15];

      let textX = pillX + padX;
      if (hasGlyph) {
        drawProviderGlyph(ctx, pillX + padX + glyphSize / 2, 0, info.provider, contentColor, 1);
        textX = pillX + padX + glyphSize + glyphGap;
      }

      ctx.font = '500 10px "Geist Mono", monospace';
      ctx.fillStyle = `rgba(${contentColor[0]}, ${contentColor[1]}, ${contentColor[2]}, 1)`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(username, textX, 0);

      ctx.restore();
    }
  }

  function updateFrameHeat(now) {
    FRAMES.forEach(f => {
      const h = frameHeat[f.id];
      if (h.agent) {
        const here = Object.values(agents).some(ag => ag && nodes[ag.nodeIdx]?.frameId === f.id);
        if (here) {
          h.intensity = Math.min(1, h.intensity + 0.03);
          h.t0 = now;
        } else {
          const age = now - h.t0;
          h.intensity = Math.max(0, 1 - age / 5500);
          if (h.intensity < 0.02) h.agent = null;
        }
      }
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
    const ell = '\u2026';
    for (let keep = text.length - 1; keep >= 2; keep--) {
      const leftLen = Math.ceil(keep / 2);
      const rightLen = keep - leftLen;
      const candidate = text.slice(0, leftLen) + ell + text.slice(text.length - rightLen);
      if (ctx.measureText(candidate).width <= maxWidth) return candidate;
    }
    return ell;
  }

  function initAgent(key, startFrame) {
    const startIdx = nodes.findIndex(n => n.frameId === startFrame && n.kind === 'file');
    const idx = startIdx >= 0 ? startIdx : 0;
    const p = nodePx(nodes[idx]);
    agents[key] = {
      nodeIdx: idx,
      x: p.x, y: p.y,
      traversing: false,
      path: [idx],
      pathStep: 0,
      arrivedAt: performance.now(),
      restUntil: performance.now() + 600 + Math.random() * 400,
      colorAmount: 0,
    };
  }

  function mainLoop() {
    const now = performance.now();
    advanceAgents(now);
    updateFrameHeat(now);
    tickMerges(now);
    updateDecisionCardVisibility();

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawFrames(now);
    drawEdges();
    drawSynapses(now);
    drawNodes(now);
    drawFloatingPRNodes(now);
    drawFloatingDecisionNodes(now);
    drawCursors(now);
    drawHoverPill(now);
    drawCompactHoverBadge(now);

    requestAnimationFrame(mainLoop);
  }

  function stepAgent(key) {
    const ag = agents[key];
    if (!ag || ag.traversing) return;
    if (performance.now() < (ag.restUntil || 0)) return;
    const next = chooseNextTarget(key);
    if (next === ag.nodeIdx) return;
    const path = bfsPath(ag.nodeIdx, next);
    if (path.length < 2) return;
    beginTraversal(key, next);
  }

  let autoSim = true;
  const autoSwitch = document.getElementById('auto-switch');
  autoSwitch.addEventListener('click', () => {
    autoSim = !autoSim;
    autoSwitch.classList.toggle('on', autoSim);
  });

  const themeSwitch = document.getElementById('theme-switch');
  themeSwitch.addEventListener('click', () => {
    document.body.classList.toggle('light');
    themeSwitch.classList.toggle('on', document.body.classList.contains('light'));
  });

  function autoLoop() {
    if (autoSim) {
      const pool = ['a','b','c'];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      stepAgent(pick);
    }
    setTimeout(autoLoop, 1400 + Math.random() * 1600);
  }

  document.querySelectorAll('.agent-btn').forEach(b => {
    b.addEventListener('click', () => stepAgent(b.dataset.agent));
  });

  const mergeBtn = document.getElementById('merge-btn');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', () => startMerge(512));
  }

  const presenceTip = document.getElementById('presence-tip');
  const presenceTipHandle = document.getElementById('presence-tip-handle');
  const presenceTipProvider = document.getElementById('presence-tip-provider');
  const presence = document.getElementById('presence');

  let avatarIntentTimer = null;
  let liftedAvatar = null;

  function showPresenceTipFor(av) {
    const handle = av.dataset.handle;
    const provider = av.dataset.provider;
    presenceTipHandle.textContent = '@' + handle;
    presenceTipProvider.textContent = provider;
    const parentRect = presence.getBoundingClientRect();
    const avRect = av.getBoundingClientRect();
    const rightOffset = parentRect.right - avRect.right;
    presenceTip.style.right = rightOffset + 'px';
    presenceTip.classList.add('visible');
  }

  function commitAvatar(av) {
    if (liftedAvatar && liftedAvatar !== av) {
      liftedAvatar.classList.remove('lifted');
    }
    av.classList.add('lifted');
    liftedAvatar = av;
    showPresenceTipFor(av);
  }

  function dismissAvatar() {
    clearTimeout(avatarIntentTimer);
    if (liftedAvatar) {
      liftedAvatar.classList.remove('lifted');
      liftedAvatar = null;
    }
    presenceTip.classList.remove('visible');
  }

  presence.querySelectorAll('.avatar').forEach(av => {
    av.addEventListener('mouseenter', () => {
      clearTimeout(avatarIntentTimer);
      avatarIntentTimer = setTimeout(() => {
        commitAvatar(av);
      }, 200);
    });
    av.addEventListener('mouseleave', () => {
      clearTimeout(avatarIntentTimer);
      if (liftedAvatar === av) {
        av.classList.remove('lifted');
        liftedAvatar = null;
        presenceTip.classList.remove('visible');
      }
    });
  });

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
      name = ref.id;
    } else {
      type = ref.kind || '';
      name = ref.name || ref.id || ref.path || '';
    }
    const refData = encodeURIComponent(JSON.stringify(ref));
    return `<span class="dc-ref-pill" data-ref-kind="${escapeHtml(ref.kind)}" data-ref="${refData}"><span class="type">${escapeHtml(type)}</span><span class="name">${escapeHtml(name)}</span></span>`;
  }

  function prPillHtml(pr) {
    return `<span class="dc-pr-pill" data-pr-num="${pr.number}"><span class="pr-state ${pr.state}"></span><span class="pr-num">#${pr.number}</span><span class="pr-title">${escapeHtml(pr.title)}</span></span>`;
  }

  function renderDecisionCard(decId) {
    const dec = DECISIONS[decId];
    if (!dec) { decisionCardEl.innerHTML = ''; return; }

    const stateLabel = dec.state;
    const provParts = [];
    if (dec.proposedBy) provParts.push(`proposed by <span class="agent">@${dec.proposedBy}</span>`);
    if (dec.proposedAt) provParts.push(`on ${dec.proposedAt}`);

    let html = '';
    html += `<div class="dc-header">
      <div class="dc-id-block">
        <div class="dc-id-row">
          <span class="dc-id">${escapeHtml(dec.id)}</span>
          <span class="dc-state-pill ${stateLabel}"><span class="sw"></span>${stateLabel}</span>
        </div>
        <div class="dc-summary">${escapeHtml(dec.summary)}</div>
        ${provParts.length ? `<div class="dc-provenance">${provParts.join(' · ')}</div>` : ''}
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

    const prGroups = [];
    if (dec.introducedIn)                      prGroups.push(['introduced in', [dec.introducedIn]]);
    if (dec.implementedBy && dec.implementedBy.length) prGroups.push(['implemented by', dec.implementedBy]);
    if (dec.challengedBy && dec.challengedBy.length)   prGroups.push(['challenged by',  dec.challengedBy]);
    if (dec.discussedIn && dec.discussedIn.length)     prGroups.push(['discussed in',   dec.discussedIn]);
    if (prGroups.length) {
      html += `<div class="dc-section"><div class="dc-section-label">pull requests</div><div class="dc-pr-row">`;
      prGroups.forEach(([label, prs]) => {
        html += `<div class="dc-pr-group"><div class="dc-pr-group-label">${escapeHtml(label)}</div><div class="dc-pr-pills">${prs.map(prPillHtml).join('')}</div></div>`;
      });
      html += `</div></div>`;
    }

    html += '</div>';
    decisionCardEl.innerHTML = html;

    const closeBtn = document.getElementById('dc-close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeDecisionCard());

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

        let frameId = null;
        if (ref.kind === 'frame') {
          frameId = ref.id;
        } else if (ref.path) {
          const match = FRAMES.find(f => ref.path === f.name || ref.path.startsWith(f.name + '/'));
          if (match) frameId = match.id;
        }
        if (frameId) {
          closeDecisionCard();
          setFocus(frameId);
        }
      });
    });

    decisionCardEl.querySelectorAll('.dc-pr-pill').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const num = el.dataset.prNum;
        if (num && PRS[num]) openPrCard(num);
      });
    });
  }

  function renderPrCard(prNum) {
    const pr = PRS[String(prNum)];
    if (!pr) { decisionCardEl.innerHTML = ''; return; }

    const stateLabel = pr.state;
    const provParts = [];
    if (pr.author) provParts.push(`opened by <span class="agent">@${pr.author}</span>`);
    if (pr.openedAt) provParts.push(`on ${pr.openedAt}`);

    let html = '';
    html += `<div class="dc-header">
      <div class="dc-id-block">
        <div class="dc-id-row">
          <span class="dc-id pr-context">#${pr.number}</span>
          <span class="dc-state-pill pr-${stateLabel}"><span class="sw"></span>${stateLabel}</span>
        </div>
        <div class="dc-summary">${escapeHtml(pr.title)}</div>
        ${provParts.length ? `<div class="dc-provenance">${provParts.join(' · ')}</div>` : ''}
      </div>
      <button class="dc-close" id="dc-close" aria-label="close">×</button>
    </div>`;

    html += '<div class="dc-body">';

    if (pr.description) {
      html += `<div class="dc-section"><div class="dc-section-label">description</div><div class="dc-prose">${escapeHtml(pr.description)}</div></div>`;
    }

    if (pr.touches && pr.touches.length) {
      const byFrame = {};
      pr.touches.forEach(t => {
        (byFrame[t.frameId] ||= []).push(t);
      });
      html += `<div class="dc-section"><div class="dc-section-label">touches</div><div class="dc-pr-row">`;
      Object.keys(byFrame).forEach(frameId => {
        const frame = FRAMES.find(f => f.id === frameId);
        const frameLabel = frame ? frame.name : frameId;
        const pills = byFrame[frameId].map(t => {
          const actionBadge = t.action === 'added' ? '+' : t.action === 'modified' ? '~' : '·';
          const refJson = encodeURIComponent(JSON.stringify({ kind: 'file', path: `${frameLabel}/${t.nodeName}`, frameId, nodeName: t.nodeName }));
          return `<span class="dc-ref-pill" data-ref-kind="file" data-ref="${refJson}"><span class="type">${t.action}</span><span class="name">${escapeHtml(t.nodeName)}</span></span>`;
        }).join('');
        html += `<div class="dc-pr-group"><div class="dc-pr-group-label">${escapeHtml(frameLabel)}</div><div class="dc-pr-pills">${pills}</div></div>`;
      });
      html += `</div></div>`;
    }

    if (pr.introducesDecision && DECISIONS[pr.introducesDecision]) {
      html += `<div class="dc-section"><div class="dc-section-label">introduces</div><div class="dc-ref-row">${refPillHtml({ kind: 'decision', id: pr.introducesDecision })}</div></div>`;
    }

    if (pr.introducesFrame) {
      const frame = FRAMES.find(f => f.id === pr.introducesFrame);
      if (frame) {
        html += `<div class="dc-section"><div class="dc-section-label">introduces frame</div><div class="dc-ref-row">${refPillHtml({ kind: 'frame', id: frame.id, label: frame.name })}</div></div>`;
      }
    }

    const relatedDecisions = [];
    Object.values(DECISIONS).forEach(dec => {
      const refs = [dec.introducedIn, ...(dec.implementedBy || []), ...(dec.challengedBy || []), ...(dec.discussedIn || [])];
      if (refs.some(r => r && r.number === pr.number)) {
        relatedDecisions.push(dec.id);
      }
    });
    if (relatedDecisions.length) {
      const uniq = Array.from(new Set(relatedDecisions));
      html += `<div class="dc-section"><div class="dc-section-label">referenced by decisions</div><div class="dc-ref-row">${uniq.map(id => refPillHtml({ kind: 'decision', id })).join('')}</div></div>`;
    }

    if (pr.commentCount) {
      html += `<div class="dc-section"><div class="dc-section-label">discussion</div><div class="dc-prose" style="color: var(--text-3); font-size: 12.5px;">${pr.commentCount} comments · last activity ${pr.lastActivityAt || 'recently'}</div></div>`;
    }

    html += '</div>';
    decisionCardEl.innerHTML = html;

    const closeBtn = document.getElementById('dc-close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeRecord());

    decisionCardEl.querySelectorAll('.dc-ref-pill').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const kind = el.dataset.refKind;
        const refData = el.dataset.ref;
        let ref = null;
        if (refData) {
          try { ref = JSON.parse(decodeURIComponent(refData)); } catch {}
        }

        if (kind === 'decision') {
          const id = el.querySelector('.name')?.textContent.trim();
          if (id && DECISIONS[id]) openDecisionCard(id);
          return;
        }

        let frameId = null;
        if (kind === 'frame') {
          frameId = ref?.id || null;
        } else if (kind === 'file' && ref?.frameId) {
          frameId = ref.frameId;
        }
        if (frameId) {
          closeRecord();
          setFocus(frameId);
        }
      });
    });
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
      } else if (focusedRecord.type === 'pr') {
        renderPrCard(focusedRecord.id);
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

  resize();
  buildGraph();

  initAgent('a', 'viewer');
  initAgent('b', 'events');
  initAgent('c', 'temporal');

  requestAnimationFrame(mainLoop);
  setTimeout(autoLoop, 900);
  setTimeout(() => stepAgent('a'), 500);
  setTimeout(() => stepAgent('b'), 1400);
  setTimeout(() => stepAgent('c'), 2200);
})();
