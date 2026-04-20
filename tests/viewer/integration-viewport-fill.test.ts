import { describe, it, expect } from 'vitest';
import {
  createSimulation,
  adaptiveScale,
  linkDistance,
  nodeCharge,
} from '../../src/viewer/shared/layout.js';
import { project } from '../../src/viewer/shared/projection.js';

// Build a synthetic state mimicking ~50 subsystem leaves
function buildState() {
  const nodes = new Map();
  const edges = new Map();
  const subsystems = ['src/events', 'src/graph', 'src/viewer', 'src/ws', 'src/mcp', 'docs/architecture', 'tests/viewer'];
  let id = 0;
  for (const s of subsystems) {
    for (let i = 0; i < 10; i++) {
      const nid = `n${id++}`;
      nodes.set(nid, { id: nid, kind: 'file', name: `f${i}.ts`, file_path: `${s}/f${i}.ts` });
    }
  }
  return { nodes, edges };
}

function settle(projection: ReturnType<typeof project>, radius: number) {
  const nodes = [...projection.visibleNodes.values()].map((n: any) => ({
    ...n,
    x: (Math.random() - 0.5) * 50,
    y: (Math.random() - 0.5) * 50,
  }));
  const edges = [...projection.visibleEdges.values()];
  const sim = createSimulation({ radius });
  sim.nodes(nodes);
  sim.force('link').links(edges);
  const adapt = adaptiveScale(nodes.length);
  sim.force('link').distance((l: any) => linkDistance(l) * adapt);
  sim.force('charge').strength((n: any) => nodeCharge(n) * adapt);
  sim.alpha(1).alphaDecay(0.1);
  for (let i = 0; i < 300; i++) sim.tick();
  sim.stop();
  return nodes;
}

function graphDiameter(nodes: any[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

describe('viewport fill across bands', () => {
  const RADIUS = 400;
  const filters = new Set(['file', 'decision']);

  it('overview and detail bands settle at similar graph diameters', () => {
    const state = buildState();
    const overviewProj = project(state, { zoom: 0.3, focus: null, filters, search: '' });
    const detailProj   = project(state, { zoom: 3.0, focus: null, filters, search: '' });

    const overviewNodes = settle(overviewProj, RADIUS);
    const detailNodes   = settle(detailProj,   RADIUS);

    const ovd = graphDiameter(overviewNodes);
    const dtd = graphDiameter(detailNodes);

    console.error(`ovd=${ovd} dtd=${dtd} ratio=${Math.max(ovd, dtd) / Math.min(ovd, dtd)}`);

    // Target ≈ 2 * RADIUS = 800. Allow ±40%.
    expect(ovd).toBeGreaterThan(2 * RADIUS * 0.6);
    expect(ovd).toBeLessThan(2 * RADIUS * 1.4);
    expect(dtd).toBeGreaterThan(2 * RADIUS * 0.6);
    expect(dtd).toBeLessThan(2 * RADIUS * 1.4);

    // And within 50% of each other.
    const ratio = Math.max(ovd, dtd) / Math.min(ovd, dtd);
    expect(ratio).toBeLessThan(1.5);
  });
});
