import type { Decision } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { OriginFields } from "../git/origin.js";
import { newUlid } from "../events/ulid.js";
import { DecisionsRepository } from "./repository.js";
import { toDecision } from "./map.js";

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

  constructor(private decisions: DecisionsRepository, deps: DecisionPromotionDeps = {}) {
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? '';
  }

  promote(id: string, tier: "team" | "public", origin?: OriginFields | null): Decision {
    const rec = this.decisions.get(id);
    if (!rec) throw new Error(`Decision not found: ${id}`);

    const fromTier = rec.tier;
    const now = new Date().toISOString();
    this.decisions.update(id, {
      tier,
      updated_at: now,
      last_touched_branch: origin?.branch ?? null,
      last_touched_commit: origin?.commit ?? null,
      last_touched_thread: origin?.thread ?? null,
    });
    const updated = this.decisions.get(id);
    if (!updated) throw new Error(`Decision disappeared after promote: ${id}`);

    this.bus?.emit({
      id: newUlid(),
      kind: 'decision.promoted',
      actor: 'claude',
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, from_tier: fromTier, to_tier: tier },
    });

    return toDecision(updated);
  }
}
