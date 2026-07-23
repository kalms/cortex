// src/viewer/canvas/presence.js
/**
 * Presence layer state (show-your-work slice 1) — one avatar per active
 * session, frame-to-frame traversal, session-colored heat. Pure state
 * machine like live-effects.js: no canvas, injectable time, self-cleaning
 * queries. Engine supplies BFS paths (setPath) for pending targets it
 * reads via pendingTarget() — presence never sees the frame graph.
 *
 * Grammar:
 *   noteActivity → upsert roster/lastSeen, bump colored heat per frame,
 *            set the session's traversal target to frameIds[0]. No prior
 *            position (or animate:false, or reducedMotion) → teleport.
 *            Otherwise the target becomes "pending" for the engine to
 *            resolve into a path via setPath.
 *   setPath  → engine hands back a BFS path for the pending target; the
 *            session advances it segment-by-segment (TRAVERSE_SEG_MS each,
 *            ease in-out quad), firing one synapse pulse per segment.
 *   idle/gone → lastSeen ages past IDLE_MS (still drawn, dimmed) then
 *            GONE_MS (dropped entirely from every query).
 *   heat     → per-frame, colored by whichever session last bumped it,
 *            decays linearly over PRESENCE_HEAT_MS.
 *
 * Traversal is advanced LAZILY inside sessions(now) — no timers. If two+
 * segments complete between polls, one synapse is pushed per crossed
 * segment boundary (with that segment's own historical t0) so a burst of
 * catch-up movement still renders as staggered pulses, not one.
 */

export const PRESENCE_HEAT_MS = 90_000;
export const IDLE_MS = 120_000;
export const GONE_MS = 900_000;
export const TRAVERSE_SEG_MS = 580;
export const HEAT_BY_ACTIVITY = { edited: 1.0, studied: 0.6, traced: 0.6, consulted: 0.4 };
// Six hues distinct from LAYER_RGB (see engine.js) and the theme accent.
export const PRESENCE_COLORS = [
  [245, 158, 11],  // amber
  [96, 165, 250],  // blue
  [192, 132, 252], // purple
  [52, 211, 153],  // emerald
  [251, 113, 133], // rose
  [45, 212, 191],  // teal
];

export function colorIdxFor(sessionId) {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return h % PRESENCE_COLORS.length;
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function createPresence({ reducedMotion = false } = {}) {
  // sessionId → { workspace, colorIdx, lastSeen, frameId, pending: {toFrameId}|null,
  //               path: string[]|null, segIdx, segT0 }
  const sess = new Map();
  // `${frameId}` → { value, colorIdx, t0 }   (latest bump wins the color)
  const heat = new Map();
  // fired traversal segments: { fromFrameId, toFrameId, t0 }
  const syn = [];

  // NB: no self-delete-on-read here (unlike live-effects' transient queues) —
  // heat entries are bounded by distinct frame count, not by event volume,
  // and presenceHeat must stay a pure function of (value, t0) so a caller
  // querying an earlier `now` after a later one still sees correct decay.
  function heatAt(frameId, now) {
    const h = heat.get(frameId);
    if (!h) return 0;
    return h.value * (1 - (now - h.t0) / PRESENCE_HEAT_MS);
  }

  function noteActivity({ sessionId, workspace, activity, frameIds = [], now, animate = true }) {
    let s = sess.get(sessionId);
    if (!s) {
      s = { workspace, colorIdx: colorIdxFor(sessionId), lastSeen: now, frameId: null, pending: null, path: null, segIdx: 0, segT0: 0 };
      sess.set(sessionId, s);
    }
    s.workspace = workspace;
    s.lastSeen = now;

    for (const fid of frameIds) {
      heat.set(fid, { value: Math.min(1, heatAt(fid, now) + (HEAT_BY_ACTIVITY[activity] ?? 0)), t0: now, colorIdx: s.colorIdx });
    }

    const target = frameIds.length > 0 ? frameIds[0] : null;
    if (target === null) return; // lastSeen-only bump

    if (s.frameId === null || animate === false || reducedMotion) {
      s.frameId = target;
      s.pending = null;
      s.path = null;
    } else if (target !== s.frameId) {
      if (s.path) {
        // Mid-traversal: let the in-flight segment finish naturally rather
        // than snapping — truncate the path to just that segment so advance()
        // stops on arrival instead of continuing toward the old destination.
        s.path = [s.path[s.segIdx], s.path[s.segIdx + 1]];
        s.segIdx = 0;
      } else {
        s.path = null;
      }
      s.pending = { toFrameId: target };
    }
  }

  function setPath(sessionId, framePath, now) {
    const s = sess.get(sessionId);
    if (!s || !s.pending) return;
    if (reducedMotion || framePath.length < 2) {
      s.frameId = s.pending.toFrameId;
      s.pending = null;
      s.path = null;
      return;
    }
    s.path = framePath;
    s.segIdx = 0;
    s.segT0 = now;
    s.pending = null;
    syn.push({ fromFrameId: framePath[0], toFrameId: framePath[1], t0: now });
  }

  function pendingTarget(sessionId) {
    const s = sess.get(sessionId);
    // Null while a path is still in flight (finish the current segment
    // first) or when there's nothing queued.
    if (!s || !s.pending || s.path) return null;
    return { fromFrameId: s.frameId, toFrameId: s.pending.toFrameId };
  }

  function advance(s, now) {
    if (!s.path) return;
    let elapsed = now - s.segT0;
    while (elapsed >= TRAVERSE_SEG_MS && s.segIdx < s.path.length - 1) {
      s.segIdx += 1;
      s.frameId = s.path[s.segIdx];
      s.segT0 += TRAVERSE_SEG_MS;
      elapsed = now - s.segT0;
      if (s.segIdx < s.path.length - 1) {
        syn.push({ fromFrameId: s.path[s.segIdx], toFrameId: s.path[s.segIdx + 1], t0: s.segT0 });
      }
    }
    if (s.segIdx >= s.path.length - 1) {
      s.path = null;
      s.segIdx = 0;
    }
  }

  function prune(now) {
    for (const [id, s] of sess) {
      if (now - s.lastSeen > GONE_MS) sess.delete(id);
    }
  }

  return {
    noteActivity,
    setPath,
    pendingTarget,

    sessions(now) {
      prune(now);
      const out = [];
      for (const [sessionId, s] of sess) {
        advance(s, now);
        let seg = null;
        if (s.path) {
          const from = s.path[s.segIdx];
          const to = s.path[s.segIdx + 1];
          const t = easeInOut(Math.min(1, Math.max(0, (now - s.segT0) / TRAVERSE_SEG_MS)));
          seg = { fromFrameId: from, toFrameId: to, t };
        }
        out.push({
          sessionId,
          workspace: s.workspace,
          colorIdx: s.colorIdx,
          idle: now - s.lastSeen > IDLE_MS,
          gone: false,
          frameId: s.frameId,
          seg,
        });
      }
      return out;
    },

    roster(now) {
      prune(now);
      const out = [];
      for (const [sessionId, s] of sess) {
        out.push({
          sessionId,
          workspace: s.workspace,
          colorIdx: s.colorIdx,
          idle: now - s.lastSeen > IDLE_MS,
          lastSeenMs: s.lastSeen,
        });
      }
      return out;
    },

    presenceHeat(frameId, now) {
      const h = heat.get(frameId);
      if (!h) return 0;
      const v = heatAt(frameId, now);
      return v <= 0 ? 0 : { value: v, colorIdx: h.colorIdx };
    },

    synapses(now) {
      const out = [];
      for (let i = syn.length - 1; i >= 0; i--) {
        const t = (now - syn[i].t0) / TRAVERSE_SEG_MS;
        if (t < 0 || t >= 1) { syn.splice(i, 1); continue; }
        out.push({ fromFrameId: syn[i].fromFrameId, toFrameId: syn[i].toFrameId, t });
      }
      return out;
    },
  };
}
