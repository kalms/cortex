import { GraphStore, NodeRow, EdgeRow } from "./store.js";

export function getConnected(
  store: GraphStore,
  nodeId: string,
  options?: { relation?: string; direction?: "outgoing" | "incoming" | "both" }
): Array<{ node: NodeRow; edge: EdgeRow }> {
  const direction = options?.direction ?? "both";
  const results: Array<{ node: NodeRow; edge: EdgeRow }> = [];

  if (direction === "outgoing" || direction === "both") {
    const filter: { source_id: string; relation?: string } = { source_id: nodeId };
    if (options?.relation) filter.relation = options.relation;
    for (const edge of store.findEdges(filter)) {
      const node = store.getNode(edge.target_id);
      if (node) results.push({ node, edge });
    }
  }

  if (direction === "incoming" || direction === "both") {
    const filter: { target_id: string; relation?: string } = { target_id: nodeId };
    if (options?.relation) filter.relation = options.relation;
    for (const edge of store.findEdges(filter)) {
      const node = store.getNode(edge.source_id);
      if (node) results.push({ node, edge });
    }
  }

  return results;
}

export function findPath(
  store: GraphStore,
  fromId: string,
  toId: string,
  maxDepth: number = 5
): Array<{ node: NodeRow; edge: EdgeRow | null }> | null {
  const startNode = store.getNode(fromId);
  if (!startNode) return null;

  const visited = new Set<string>([fromId]);
  const queue: Array<{
    nodeId: string;
    path: Array<{ node: NodeRow; edge: EdgeRow | null }>;
  }> = [{ nodeId: fromId, path: [{ node: startNode, edge: null }] }];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.nodeId === toId) return current.path;
    if (current.path.length > maxDepth) continue;

    for (const edge of store.findEdges({ source_id: current.nodeId })) {
      if (!visited.has(edge.target_id)) {
        visited.add(edge.target_id);
        const targetNode = store.getNode(edge.target_id);
        if (targetNode) {
          queue.push({
            nodeId: edge.target_id,
            path: [...current.path, { node: targetNode, edge }],
          });
        }
      }
    }
  }

  return null;
}
