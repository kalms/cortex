import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
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

export function createSimulation() {
  return forceSimulation()
    .force('link',   forceLink().id(n => n.id).distance(linkDistance).strength(linkStrength))
    .force('charge', forceManyBody().strength(nodeCharge))
    .force('center', forceCenter(0, 0).strength(0.12))
    .force('collide', forceCollide().radius(n => nodeSize(n) + 4))
    .alpha(1);
}
