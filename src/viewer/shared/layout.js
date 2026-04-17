import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from 'd3-force';

/**
 * d3-force configuration for the 2D graph viewer.
 *
 * Pure tables for kind → size / charge and relation → distance / strength are
 * exported so the render loop can use them directly and tests can assert
 * their contents. `createSimulation()` wires them into a running simulation.
 */

const SIZE = {
  decision: 7.5,
  file: 5,
  function: 2.5,
  component: 4.5,
  reference: 4.5,
  path: 3.5,
};

const CHARGE = {
  decision: -300,
  file: -100,
  function: -50,
  component: -50,
  reference: -50,
  path: -30,
};

const LINK_DIST = {
  GOVERNS: 70,
  CALLS: 80,
  IMPORTS: 100,
  SUPERSEDES: 60,
  REFERENCES: 100,
  'co-changed': 200,
};

const LINK_STR = {
  GOVERNS: 0.8,
  CALLS: 0.5,
  IMPORTS: 0.4,
  SUPERSEDES: 0.6,
  REFERENCES: 0.4,
  'co-changed': 0.1,
};

export function nodeSize(kind) {
  return SIZE[kind] ?? 4;
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

/**
 * Build a running d3 simulation, forces pre-configured.
 * Call `.nodes(...)` and `.force('link').links(...)` on the returned sim
 * after hydrating graph state.
 */
export function createSimulation() {
  return forceSimulation()
    .force('link',   forceLink().id(n => n.id).distance(linkDistance).strength(linkStrength))
    .force('charge', forceManyBody().strength(nodeCharge))
    .force('center', forceCenter(0, 0).strength(0.03))
    .force('collide', forceCollide().radius(n => nodeSize(n.kind) + 4))
    .alpha(1);
}
