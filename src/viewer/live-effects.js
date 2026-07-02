// src/viewer/live-effects.js
/**
 * Live-change treatment state (E · v5 live grammar) — the transient layer the
 * canvas queries every frame. Pure state machine: no canvas, injectable time.
 *
 * Grammar (spec-locked, NO pulse animations — every signal decays):
 *   create → outline "sketch" fills over BIRTH_MS (v5 added-node → merge beat)
 *   update → connections fire once (LEADER_MS triangular peak) + halo lifts
 *            and DRAINS linearly over HALO_MS (v5 colorAmount decay)
 *   remove → fill drains back to outline and fades (tombstone, REMOVE_MS)
 *   residue → frameHeat: border warmth bumps (+HEAT_BUMP, capped 1) and
 *            decays over HEAT_DECAY_MS (v5 frameHeat)
 *   attribution → presence pill riding the change; agent = 'claude'/'system'
 *            (glyph + agent color), user = anything else (@name, base-white)
 *
 * reducedMotion collapses all motion to instant state changes but keeps the
 * attribution pills (information, not decoration) on a fixed short window.
 */

export const BIRTH_MS = 500;
export const HALO_MS = 3500;
export const LEADER_MS = 580;
export const REMOVE_MS = 500;
export const HEAT_DECAY_MS = 5500;
export const HEAT_BUMP = 0.5;
const REDUCED_PILL_MS = 2000;

export function createLiveEffects({ reducedMotion = false } = {}) {
  const births = new Map();     // id → t0
  const halos = new Map();      // id → t0
  const leaders = new Map();    // id → t0
  const heat = new Map();       // frameId → { value, t0 } (value at t0, then linear decay)
  const tombs = new Map();      // id → { entity, x, y, t0 }
  const pillsById = new Map();  // id → { x, y, name, isUser, t0 }
  const dotPos = new Map();     // id → { x, y }

  function heatAt(frameId, now) {
    const h = heat.get(frameId);
    if (!h) return 0;
    const v = h.value * (1 - (now - h.t0) / HEAT_DECAY_MS);
    return v > 0 ? v : 0;
  }

  function noteChange({ kind, entity, id, frameIds = [], actor, now }) {
    const isUser = actor !== "claude" && actor !== "system";
    const pos = dotPos.get(id) || { x: null, y: null };
    pillsById.set(id, { x: pos.x, y: pos.y, name: isUser ? "@" + actor : actor, isUser, t0: now });

    if (reducedMotion) return; // pills only

    for (const fid of frameIds) {
      heat.set(fid, { value: Math.min(1, heatAt(fid, now) + HEAT_BUMP), t0: now });
    }
    if (kind === "create") { births.set(id, now); leaders.set(id, now); }
    else if (kind === "update") { halos.set(id, now); leaders.set(id, now); }
    else if (kind === "remove") {
      births.delete(id); halos.delete(id); leaders.delete(id);
      const p = dotPos.get(id);
      if (p) tombs.set(id, { entity, x: p.x, y: p.y, t0: now });
    }
  }

  return {
    noteChange,
    recordDotPos(id, x, y) { dotPos.set(id, { x, y }); },

    birth(id, now) {
      const t0 = births.get(id);
      if (t0 === undefined) return null;
      const t = (now - t0) / BIRTH_MS;
      if (t >= 1) { births.delete(id); return null; }
      return Math.max(0, t);
    },

    haloLift(id, now) {
      const t0 = halos.get(id);
      if (t0 === undefined) return 0;
      const v = 1 - (now - t0) / HALO_MS;
      if (v <= 0) { halos.delete(id); return 0; }
      return v;
    },

    leaderBoost(id, now) {
      const t0 = leaders.get(id);
      if (t0 === undefined) return 0;
      const t = (now - t0) / LEADER_MS;
      if (t >= 1) { leaders.delete(id); return 0; }
      return t <= 0 ? 0 : 1 - Math.abs(t - 0.5) * 2;
    },

    frameHeat(frameId, now) { return reducedMotion ? 0 : heatAt(frameId, now); },

    tombstones(now) {
      const out = [];
      for (const [id, tb] of tombs) {
        const t = (now - tb.t0) / REMOVE_MS;
        if (t >= 1) { tombs.delete(id); continue; }
        out.push({ id, entity: tb.entity, x: tb.x, y: tb.y, t: Math.max(0, t) });
      }
      return out;
    },

    pills(now) {
      const windowMs = reducedMotion ? REDUCED_PILL_MS : HALO_MS;
      const out = [];
      for (const [id, p] of pillsById) {
        const age = now - p.t0;
        if (age >= windowMs) { pillsById.delete(id); continue; }
        // Lazily adopt a position learned after the pill fired (fresh creates).
        const pos = (p.x === null && dotPos.has(id)) ? dotPos.get(id) : p;
        out.push({ id, x: pos.x, y: pos.y, name: p.name, isUser: p.isUser, alpha: 1 - age / windowMs });
      }
      return out;
    },
  };
}
