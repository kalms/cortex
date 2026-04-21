import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
} from 'd3-force';
import { worldSize, groupWorldSize } from './sizing.js';

/**
 * d3-force configuration for the 2D viewer.
 *
 * Charges and link distances/strengths live here (they're force-specific);
 * node sizes come from sizing.js so the render and the physics agree.
 */

const CHARGE = {
  decision: -220,
  file:     -80,
  function: -40,
  component: -40,
  reference: -40,
  path:     -25,
  group:    -180,   // supernodes repel like mid-weight decisions
};

const LINK_DIST = {
  GOVERNS: 45,
  CALLS: 55,
  IMPORTS: 70,
  SUPERSEDES: 40,
  REFERENCES: 70,
  'co-changed': 140,
};

const LINK_STR = {
  GOVERNS: 0.8,
  CALLS: 0.5,
  IMPORTS: 0.4,
  SUPERSEDES: 0.6,
  REFERENCES: 0.4,
  'co-changed': 0.1,
};

export function nodeSize(kindOrNode) {
  // Accept either a kind string (test convention) or a node object.
  if (typeof kindOrNode === 'string') return worldSize(kindOrNode);
  const n = kindOrNode;
  if (n.kind === 'group') return groupWorldSize(n.memberCount ?? 1);
  return worldSize(n.kind);
}

export function nodeCharge(node) {
  return CHARGE[node.kind] ?? -50;
}

export function linkDistance(link) {
  return LINK_DIST[link.relation] ?? 120;
}

export function linkStrength(link) {
  return LINK_STR[link.relation] ?? 0.3;
}

const DEFAULT_BOUNDARY_STRENGTH = 0.8;
const DEFAULT_GROUP_STRENGTH    = 0.35;
const DEFAULT_GOVERN_STRENGTH   = 0.25;

function collideRadius(n) {
  if (n.kind === 'group' && n.radius) return n.radius + 4;
  return nodeSize(n) + 4;
}

export function createSimulation(opts = {}) {
  const radius = opts.radius ?? 400;
  return forceSimulation()
    .force('link',       forceLink().id(n => n.id).distance(linkDistance).strength(linkStrength))
    .force('charge',     forceManyBody().strength(nodeCharge))
    .force('collide',    forceCollide().radius(collideRadius))
    .force('boundary',   forceBoundary(radius, DEFAULT_BOUNDARY_STRENGTH))
    .force('group',      forceGroup(DEFAULT_GROUP_STRENGTH))
    .force('governance', forceGovernance(DEFAULT_GOVERN_STRENGTH))
    .alpha(1);
}

/**
 * Soft outer containment force. Nodes inside `radius` feel zero force;
 * nodes outside feel an inward spring whose magnitude scales with how far
 * past the radius they are. Pairs with group gravity to produce a circular
 * layout with free interior placement.
 *
 *   radius   — containment radius in world units
 *   strength — spring constant (default 0.8)
 *   cx, cy   — center point in world units (default 0, 0)
 */
export function forceBoundary(radius, strength = 0.8, cx = 0, cy = 0) {
  let nodes;
  function f(alpha) {
    for (const n of nodes) {
      const dx = n.x - cx;
      const dy = n.y - cy;
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        const excess = d - radius;
        const factor = strength * alpha * (excess / d);
        n.vx -= dx * factor;
        n.vy -= dy * factor;
      }
    }
  }
  f.initialize = function(_nodes) { nodes = _nodes; };
  f.strength = function(s) { if (arguments.length) { strength = s; return f; } return strength; };
  f.radius = function(r) { if (arguments.length) { radius = r; return f; } return radius; };
  return f;
}

/**
 * Group gravity. Each non-supernode with a `group` property feels a pull
 * toward its group's centroid (computed from peers sharing the same group).
 * Supernodes do NOT feel this force — they're the anchors peers pull toward.
 * Nodes without a group are untouched.
 *
 *   strength — default 0.35
 */
export function forceGroup(strength = 0.35) {
  let nodes;
  function f(alpha) {
    const centroids = new Map();
    for (const n of nodes) {
      if (!n.group) continue;
      let c = centroids.get(n.group);
      if (!c) { c = { x: 0, y: 0, count: 0 }; centroids.set(n.group, c); }
      c.x += n.x; c.y += n.y; c.count += 1;
    }
    for (const c of centroids.values()) { c.x /= c.count; c.y /= c.count; }
    for (const n of nodes) {
      if (!n.group || n.kind === 'group') continue;
      const c = centroids.get(n.group);
      if (!c) continue;
      n.vx += (c.x - n.x) * strength * alpha;
      n.vy += (c.y - n.y) * strength * alpha;
    }
  }
  f.initialize = function(_nodes) { nodes = _nodes; };
  f.strength = function(s) { if (arguments.length) { strength = s; return f; } return strength; };
  return f;
}

/**
 * Governance gravity. Each decision is pulled toward the centroid of its
 * `governs` targets that are currently in the node set. A decision with
 * no visible territory feels no force (no drift, no NaN).
 *
 *   strength — default 0.25
 */
export function forceGovernance(strength = 0.25) {
  let nodes;
  function f(alpha) {
    const byId = new Map();
    for (const n of nodes) byId.set(n.id, n);
    for (const n of nodes) {
      if (n.kind !== 'decision') continue;
      let tx = 0, ty = 0, count = 0;
      for (const targetId of (n.governs || [])) {
        const t = byId.get(targetId);
        if (t) { tx += t.x; ty += t.y; count += 1; }
      }
      if (count === 0) continue;
      tx /= count; ty /= count;
      n.vx += (tx - n.x) * strength * alpha;
      n.vy += (ty - n.y) * strength * alpha;
    }
  }
  f.initialize = function(_nodes) { nodes = _nodes; };
  f.strength = function(s) { if (arguments.length) { strength = s; return f; } return strength; };
  return f;
}

/**
 * Scale factor for link distance + charge, inversely proportional to
 * sqrt(N visible). Keeps the graph's natural radius ≈ constant across
 * bands as the visible node count changes.
 */
export function adaptiveScale(visibleCount) {
  return 50 / Math.sqrt(Math.max(1, visibleCount));
}
