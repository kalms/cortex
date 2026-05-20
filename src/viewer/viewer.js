import { fetchProjects, fetchGraph, fetchDecisions, fetchAggregates } from '/viewer/data-fetch.js';
import { groupNodesIntoFrames, basenames, buildFrameGovernance } from '/viewer/adapters.js';
import { gridLayout } from '/viewer/layout.js';

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

  let FRAMES = [];
  let NODE_CFG = {};
  let FILE_NAMES = {};

  const nodes = [];
  const edges = [];
  const adjacency = {};

  let focusedFrameId = null;
  let focusT0 = 0;
  const FOCUS_DURATION = 550;
  let previousFocusId = null;

  let DECISIONS = {};
  let FRAME_GOVERNANCE = {};
  let AGGREGATES = [];

  function getDecision(id) { return DECISIONS[id]; }
  function getFrameDecisions(frameId) {
    return (FRAME_GOVERNANCE[frameId] || []).map(getDecision).filter(Boolean);
  }

  let currentProject = null;

  async function loadGraph(projectName) {
    currentProject = projectName;
    const [graph, decs, aggs] = await Promise.all([
      fetchGraph(projectName),
      fetchDecisions(projectName),
      fetchAggregates(projectName),
    ]);
    AGGREGATES = aggs.aggregates || [];

    // 1. Build frame summaries from the graph.
    const summaries = groupNodesIntoFrames(graph.nodes);

    // 2. Position via grid layout. Reserve 90px at the bottom for the
    // aggregate strip so frames never overlap auxiliary aggregate dots.
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const AGGREGATE_STRIP_H = AGGREGATES.length > 0 ? 90 : 0;
    const layoutH = stageH - AGGREGATE_STRIP_H;
    const positioned = gridLayout(
      summaries.map((s) => ({
        frame_id: s.frame_id,
        frame_label: s.frame_label,
        member_count: s.member_count,
      })),
      stageW, layoutH,
    );

    // 3. Replace FRAMES with positioned frames (string id matches the rest of
    // the file's expectation that id is a string).
    FRAMES = positioned.map((p) => ({
      id: String(p.id),
      name: p.name,
      x: p.x / stageW,
      y: p.y / stageH,
      w: p.w,
      h: p.h,
      count: p.count,
    }));

    // 4. NODE_CFG.count = how many file basenames to show per frame (cap at 16).
    NODE_CFG = {};
    FILE_NAMES = {};
    for (const s of summaries) {
      const sid = String(s.frame_id);
      NODE_CFG[sid] = { count: Math.min(s.member_count, 16) };
      FILE_NAMES[sid] = basenames(s.members, 16);
    }

    // 5. Decisions → DECISIONS map + FRAME_GOVERNANCE rollup.
    DECISIONS = {};
    for (const d of decs.decisions) {
      DECISIONS[d.id] = d;
    }
    FRAME_GOVERNANCE = buildFrameGovernance(decs.decisions);

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
    select.addEventListener('change', () => loadGraph(select.value || null));
    themeToggle.addEventListener('click', () => document.body.classList.toggle('light'));

    await loadGraph(active);
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function buildGraph() {
    nodes.length = 0; edges.length = 0;
    Object.keys(adjacency).forEach(k => delete adjacency[k]);

    FRAMES.forEach(frame => {
      const cfg = NODE_CFG[frame.id] || { count: 0 };
      for (let i = 0; i < cfg.count; i++) {
        nodes.push({
          id: frame.id + '-' + i,
          frameId: frame.id,
          kind: 'file',
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

    const decHover = decisionNodeAtPoint(px, py);
    hoveredDecisionId = decHover ? decHover.id : null;

    if (decHover) {
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

  const decisionNodeRects = [];
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

      const baseFillAlpha = 0.25 * (1 - dimLevel * 0.4);
      const fillAlpha = baseFillAlpha + hoverLevel * 0.18;
      const ff = frameFillRGB();
      const fillAlphaActual = isLight() ? fillAlpha * 0.45 : fillAlpha;
      ctx.fillStyle = `rgba(${ff[0]}, ${ff[1]}, ${ff[2]}, ${fillAlphaActual})`;
      ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);

      const baseBorderAlpha = 0.08;
      const focusBoost = isFocused ? 0.12 : 0;
      const hoverBorderBoost = hoverLevel * 0.2;
      const borderAlphaMult = isLight() ? 3.0 : 1;
      const borderAlpha = (baseBorderAlpha + focusBoost + hoverBorderBoost) * (1 - dimLevel * 0.5) * borderAlphaMult;

      const fb = frameBorderRGB();
      ctx.strokeStyle = `rgba(${fb[0]}, ${fb[1]}, ${fb[2]}, ${borderAlpha})`;
      ctx.lineWidth = isFocused ? 1.2 : 1;
      roundedRect(ctx, -f.w / 2, -f.h / 2, f.w, f.h, 4);
      ctx.stroke();

      const isLabelHovered = hoveredLabelFrameId === frame.id;
      const labelAlpha = 0.5 * (1 - dimLevel * 0.55);
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
      const state = dec.state || 'active';
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

      const nodeIdxs = dec._nodeIdxs || [];
      nodeIdxs.forEach(idx => {
        const p = nodePx(nodes[idx]);
        ctx.strokeStyle = `rgba(${leaderColor[0]}, ${leaderColor[1]}, ${leaderColor[2]}, ${leaderAlpha * alphaMult})`;
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

    ctx.restore();
  }

  function drawEdges() {
    edges.forEach((e) => {
      const a = nodePx(nodes[e.a]);
      const b = nodePx(nodes[e.b]);
      const restAlpha = e.interFrame ? 0.09 : 0.15;

      ctx.save();
      const alpha = restAlpha * (isLight() ? 2.2 : 1);
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
   * Draw auxiliary aggregates as bare dots in a bottom strip — spec
   * §"Two content streams": each aggregate is a peer entity to frames,
   * one dot with a count badge. Dots scale by sqrt(count).
   */
  function drawAggregates(now) {
    if (!AGGREGATES || AGGREGATES.length === 0) return;
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const stripTop = stageH - 90;
    const slotW = stageW / Math.max(AGGREGATES.length, 1);
    let maxCount = 1;
    for (const a of AGGREGATES) {
      if (a.member_count > maxCount) maxCount = a.member_count;
    }

    ctx.save();
    for (let i = 0; i < AGGREGATES.length; i++) {
      const agg = AGGREGATES[i];
      const cx = slotW * (i + 0.5);
      const cy = stripTop + 28;
      const dotR = 5 + 10 * Math.sqrt(agg.member_count / maxCount);

      const baseRgb = nodeBaseRGB();
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]},0.55)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]},0.9)`;
      ctx.lineWidth = 1;
      ctx.stroke();

      const labelRgb = subLabelRGB();
      ctx.fillStyle = `rgba(${labelRgb[0]},${labelRgb[1]},${labelRgb[2]},0.95)`;
      ctx.font = '10px "Geist Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelMax = slotW - 6;
      ctx.fillText(truncateMiddle(ctx, agg.label, labelMax), cx, cy + dotR + 6);

      const countRgb = countIdleRGB();
      ctx.fillStyle = `rgba(${countRgb[0]},${countRgb[1]},${countRgb[2]},0.9)`;
      ctx.font = '500 9px "Geist Mono", monospace';
      ctx.fillText(String(agg.member_count), cx, cy + dotR + 20);
    }
    ctx.restore();
  }

  function mainLoop() {
    const now = performance.now();
    updateDecisionCardVisibility();

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawFrames(now);
    drawEdges();
    drawNodes(now);
    drawFloatingDecisionNodes(now);
    drawAggregates(now);
    drawHoverPill(now);
    drawCompactHoverBadge(now);

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
      name = ref.id;
    } else {
      type = ref.kind || '';
      name = ref.name || ref.id || ref.path || '';
    }
    const refData = encodeURIComponent(JSON.stringify(ref));
    return `<span class="dc-ref-pill" data-ref-kind="${escapeHtml(ref.kind)}" data-ref="${refData}"><span class="type">${escapeHtml(type)}</span><span class="name">${escapeHtml(name)}</span></span>`;
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
