import { GraphStore, NodeRow } from "../graph/store.js";
import type { Decision, CreateDecisionInput, UpdateDecisionInput } from "./types.js";
import { nodeToDecision } from "./types.js";

export class DecisionService {
  constructor(private store: GraphStore) {}

  create(input: CreateDecisionInput): Decision {
    const data = {
      title: input.title,
      description: input.description,
      rationale: input.rationale,
      alternatives: input.alternatives ?? [],
      status: "active" as const,
    };

    const node = this.store.createNode({
      kind: "decision",
      name: input.title,
      data,
      tier: "personal",
    });

    this.store.indexDecisionContent(node.id, input.title, input.description, input.rationale);

    if (input.governs) {
      for (const target of input.governs) {
        this.linkGoverns(node.id, target);
      }
    }

    if (input.references) {
      for (const ref of input.references) {
        this.store.createEdge({
          source_id: node.id,
          target_id: ref,
          relation: "REFERENCES",
        });
      }
    }

    return nodeToDecision(node);
  }

  linkGoverns(decisionId: string, target: string): void {
    const existingNode = this.store.getNode(target);
    if (existingNode) {
      this.store.createEdge({
        source_id: decisionId,
        target_id: target,
        relation: "GOVERNS",
      });
      return;
    }

    const pathNodes = this.store.findNodes({ file_path: target, kind: "path" });
    let pathNode: NodeRow;
    if (pathNodes.length > 0) {
      pathNode = pathNodes[0];
    } else {
      pathNode = this.store.createNode({
        kind: "path",
        name: target.split("/").pop() || target,
        file_path: target,
        tier: "public",
      });
    }

    this.store.createEdge({
      source_id: decisionId,
      target_id: pathNode.id,
      relation: "GOVERNS",
    });
  }

  linkReference(decisionId: string, targetId: string): void {
    this.store.createEdge({
      source_id: decisionId,
      target_id: targetId,
      relation: "REFERENCES",
    });
  }
}
