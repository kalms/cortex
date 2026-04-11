import { GraphStore } from "../graph/store.js";
import type { Decision } from "./types.js";
import { nodeToDecision } from "./types.js";

export class DecisionPromotion {
  constructor(private store: GraphStore) {}

  promote(id: string, tier: "team" | "public"): Decision {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const updatedNode = this.store.updateNode(id, { tier });
    return nodeToDecision(updatedNode);
  }
}
