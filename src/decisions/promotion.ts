import { GraphStore } from "../graph/store.js";
import type { Decision } from "./types.js";
import { nodeToDecision } from "./types.js";
import type { EventBus } from "../events/bus.js";
import { newUlid } from "../events/ulid.js";

/**
 * Optional dependencies for DecisionPromotion.
 *
 * `bus` is optional so existing call sites (tests, one-off scripts) continue
 * to work without backwards-incompatible changes. When provided, promote()
 * emits a `decision.promoted` event after the SQLite tier write succeeds.
 */
export interface DecisionPromotionDeps {
  bus?: EventBus;
  project_id?: string;
}

export class DecisionPromotion {
  private bus: EventBus | undefined;
  private projectId: string;

  constructor(private store: GraphStore, deps: DecisionPromotionDeps = {}) {
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? '';
  }

  promote(id: string, tier: "team" | "public"): Decision {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const fromTier = node.tier ?? 'personal';
    const updatedNode = this.store.updateNode(id, { tier });
    const decision = nodeToDecision(updatedNode);

    this.bus?.emit({
      id: newUlid(),
      kind: 'decision.promoted',
      actor: 'claude',
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, from_tier: fromTier, to_tier: tier },
    });

    return decision;
  }
}
