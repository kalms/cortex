import { GraphStore, NodeRow } from "../graph/store.js";
import type { Decision } from "./types.js";
import { nodeToDecision } from "./types.js";
import { dirname } from "node:path";

export class DecisionSearch {
  constructor(private store: GraphStore) {}

  search(query: string, scope?: string): Decision[] {
    const ftsResults = this.store.searchDecisionContent(query);
    const nodeIds = ftsResults.map((r) => r.node_id);

    if (!scope) {
      return nodeIds
        .map((id) => this.store.getNode(id))
        .filter((n): n is NodeRow => n !== undefined)
        .map((n) => nodeToDecision(n));
    }

    return nodeIds
      .filter((id) => this.governsScope(id, scope))
      .map((id) => this.store.getNode(id))
      .filter((n): n is NodeRow => n !== undefined)
      .map((n) => nodeToDecision(n));
  }

  whyWasThisBuilt(qualifiedName: string): Decision[] {
    // 1. Try qualified_name match
    const qnNodes = this.store.findNodes({ qualified_name: qualifiedName });
    if (qnNodes.length > 0) {
      const decisions = this.findGoverningDecisions(qnNodes[0].id);
      if (decisions.length > 0) return decisions;
    }

    // 2. Try file_path match
    const fileNodes = this.store.findNodes({ file_path: qualifiedName });
    for (const fileNode of fileNodes) {
      const decisions = this.findGoverningDecisions(fileNode.id);
      if (decisions.length > 0) return decisions;
    }

    // 3. Walk up directory hierarchy via path nodes
    let currentPath = qualifiedName;
    while (currentPath.includes("/")) {
      currentPath = dirname(currentPath);
      if (currentPath === ".") break;
      const trailingSlash = currentPath + "/";

      // Check both with and without trailing slash
      for (const searchPath of [currentPath, trailingSlash]) {
        const dirNodes = this.store.findNodes({ file_path: searchPath });
        for (const dirNode of dirNodes) {
          const decisions = this.findGoverningDecisions(dirNode.id);
          if (decisions.length > 0) return decisions;
        }
      }
    }

    return [];
  }

  private findGoverningDecisions(nodeId: string): Decision[] {
    const edges = this.store.findEdges({ target_id: nodeId, relation: "GOVERNS" });
    return edges
      .map((e) => this.store.getNode(e.source_id))
      .filter((n): n is NodeRow => n !== undefined && n.kind === "decision")
      .map((n) => nodeToDecision(n));
  }

  private governsScope(decisionId: string, scope: string): boolean {
    const edges = this.store.findEdges({ source_id: decisionId, relation: "GOVERNS" });
    for (const edge of edges) {
      const target = this.store.getNode(edge.target_id);
      if (!target) continue;
      if (target.qualified_name === scope) return true;
      if (target.file_path === scope) return true;
      if (target.file_path && scope.startsWith(target.file_path)) return true;
    }
    return false;
  }
}
