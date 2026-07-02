import type Database from "better-sqlite3";
import type { Decision, CreateDecisionInput, UpdateDecisionInput, ProposeDecisionInput, SupersedeDecisionInput, DecisionWithRefs } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository, TargetKind, Relation } from "./links-repository.js";
import { mintId } from "../ids/allocator.js";
import { parseRef } from "../ids/short-id.js";
import { classifyGovernsTarget } from "../shared/classify-ref.js";

export interface DecisionServiceDeps {
  db: Database.Database;
  decisions: DecisionsRepository;
  links: DecisionLinksRepository;
  bus?: EventBus;
  project_id?: string;
}

export class DecisionService {
  private db: Database.Database;
  private decisions: DecisionsRepository;
  private links: DecisionLinksRepository;
  private bus: EventBus | undefined;
  private projectId: string;

  constructor(deps: DecisionServiceDeps) {
    this.db = deps.db;
    this.decisions = deps.decisions;
    this.links = deps.links;
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? "";
  }

  create(input: CreateDecisionInput): Decision {
    const now = new Date().toISOString();
    const { id, seq } = mintId(this.db, "decision", (cand) => this.decisions.get(cand) != null);
    const rec: DecisionRecord = {
      id,
      seq,
      title: input.title,
      description: input.description ?? null,
      rationale: input.rationale,
      problem: input.problem ?? null,
      resolution: input.resolution ?? null,
      alternatives: input.alternatives ? JSON.stringify(input.alternatives) : null,
      tier: "personal",
      status: "active",
      superseded_by: null,
      author: input.author ?? "claude",
      provenance: input.provenance ? JSON.stringify(input.provenance) : null,
      created_at: now,
      updated_at: now,
    };
    this.decisions.insert(rec);

    if (input.governs) {
      for (const target of input.governs) {
        this.addLink(id, classifyTarget(target), target, "GOVERNS", now);
      }
    }
    if (input.references) {
      for (const ref of input.references) {
        this.addLink(id, classifyTarget(ref), ref, "REFERENCES", now);
      }
    }

    this.emit({
      id: newUlid(),
      kind: "decision.created",
      actor: rec.author ?? "claude",
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, title: input.title, rationale: input.rationale, governed_file_ids: input.governs ?? [], tags: [] },
    });

    return toDecision(rec);
  }

  /** Resolve a canonical id, "D-<seq>", or bare "<seq>" to the stored record. */
  private resolveRecord(ref: string): DecisionRecord | null {
    const direct = this.decisions.get(ref);
    if (direct) return direct; // exact canonical id (fast path)
    const parsed = parseRef("decision", ref);
    if (!parsed) return null;
    if (parsed.kind === "seq") return this.decisions.getBySeq(parsed.seq);
    return this.decisions.get(parsed.id);
  }

  get(id: string): Decision | null {
    const rec = this.resolveRecord(id);
    return rec ? toDecision(rec) : null;
  }

  update(id: string, input: UpdateDecisionInput, opts: { emit?: boolean } = { emit: true }): Decision {
    const existing = this.resolveRecord(id);
    if (!existing) throw new Error(`Decision not found: ${id}`);
    const canonicalId = existing.id;
    const now = new Date().toISOString();
    const patch: Partial<DecisionRecord> = { updated_at: now };
    const changedFields: string[] = [];
    if (input.title !== undefined) { patch.title = input.title; changedFields.push("title"); }
    if (input.description !== undefined) { patch.description = input.description; changedFields.push("description"); }
    if (input.rationale !== undefined) { patch.rationale = input.rationale; changedFields.push("rationale"); }
    if (input.alternatives !== undefined) {
      patch.alternatives = JSON.stringify(input.alternatives);
      changedFields.push("alternatives");
    }
    if (input.status !== undefined) { patch.status = input.status; changedFields.push("status"); }
    if (input.superseded_by !== undefined) {
      patch.superseded_by = input.superseded_by;
      changedFields.push("superseded_by");
    }
    if (input.problem !== undefined) { patch.problem = input.problem; changedFields.push("problem"); }
    if (input.resolution !== undefined) { patch.resolution = input.resolution; changedFields.push("resolution"); }
    if (input.author !== undefined) patch.author = input.author;
    this.decisions.update(canonicalId, patch);

    // Governance replacement — full set semantics.
    if (input.governs !== undefined) {
      this.replaceLinks(canonicalId, "GOVERNS", input.governs, now);
    }
    if (input.references !== undefined) {
      this.replaceLinks(canonicalId, "REFERENCES", input.references, now);
    }

    if (opts.emit !== false) {
      // If the update marked the decision superseded, prefer the
      // decision.superseded signal over decision.updated (legacy contract).
      const becameSuperseded =
        patch.status === "superseded" && patch.superseded_by != null;
      if (becameSuperseded) {
        this.emit({
          id: newUlid(),
          kind: "decision.superseded",
          actor: patch.author ?? existing.author ?? "claude",
          created_at: Date.now(),
          project_id: this.projectId,
          payload: { old_id: canonicalId, new_id: patch.superseded_by!, reason: "" },
        });
      } else {
        this.emit({
          id: newUlid(),
          kind: "decision.updated",
          actor: patch.author ?? existing.author ?? "claude",
          created_at: Date.now(),
          project_id: this.projectId,
          payload: { decision_id: canonicalId, changed_fields: changedFields },
        });
      }
    }

    return toDecision({ ...existing, ...patch } as DecisionRecord);
  }

  delete(id: string): void {
    const existing = this.resolveRecord(id);
    if (!existing) return; // idempotent: missing decision is a no-op
    const canonicalId = existing.id;
    this.decisions.delete(canonicalId);
    this.emit({
      id: newUlid(),
      kind: "decision.deleted",
      actor: existing.author ?? "claude",
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: canonicalId, title: existing.title },
    });
  }

  search(query: string): Decision[] {
    return this.decisions.search(query).map(toDecision);
  }

  list(): Decision[] {
    return this.decisions.list().map(toDecision);
  }

  linkGoverns(decisionId: string, target: string): void {
    this.addLink(decisionId, classifyTarget(target), target, "GOVERNS", new Date().toISOString());
  }

  linkReference(decisionId: string, target: string): void {
    this.addLink(decisionId, classifyTarget(target), target, "REFERENCES", new Date().toISOString());
  }

  supersede(input: SupersedeDecisionInput): Decision {
    // Validate the target exists BEFORE creating the replacement, so we don't
    // leave an orphan if old_decision_id is bogus.
    const oldExisting = this.resolveRecord(input.old_decision_id);
    if (!oldExisting) {
      throw new Error(`Decision not found: ${input.old_decision_id}`);
    }
    const oldCanonicalId = oldExisting.id;
    const replacement = this.create({
      title: input.title,
      description: input.resolution ?? "",
      rationale: input.rationale,
      alternatives: input.alternatives,
      governs: input.governs,
      references: input.references,
      author: input.author,
      problem: input.problem,
      resolution: input.resolution,
    });
    this.update(oldCanonicalId, {
      status: "superseded",
      superseded_by: replacement.id,
      author: input.author,
    }, { emit: false });
    this.links.add({
      decision_id: replacement.id,
      target_kind: "decision",
      target_ref: oldCanonicalId,
      relation: "SUPERSEDES",
      created_at: new Date().toISOString(),
    });
    this.emit({
      id: newUlid(),
      kind: "decision.superseded",
      actor: input.author ?? "claude",
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { old_id: oldCanonicalId, new_id: replacement.id, reason: "" },
    });
    return replacement;
  }

  propose(input: ProposeDecisionInput): Decision {
    const now = new Date().toISOString();
    const { id, seq } = mintId(this.db, "decision", (cand) => this.decisions.get(cand) != null);
    const rec: DecisionRecord = {
      id,
      seq,
      title: input.title,
      description: input.resolution ?? null,
      rationale: input.rationale,
      problem: input.problem ?? null,
      resolution: input.resolution ?? null,
      alternatives: input.alternatives ? JSON.stringify(input.alternatives) : null,
      tier: "personal",
      status: "proposed",
      superseded_by: null,
      author: input.author ?? "claude",
      provenance: input.provenance ? JSON.stringify(input.provenance) : null,
      created_at: now,
      updated_at: now,
    };
    this.decisions.insert(rec);
    for (const target of input.governs ?? []) this.linkGoverns(id, target);
    for (const ref of input.references ?? []) this.linkReference(id, ref);
    if (input.pr_number != null) {
      this.links.add({
        decision_id: id,
        target_kind: "pr",
        target_ref: String(input.pr_number),
        relation: "PR_INTRODUCES_DECISION",
        created_at: now,
      });
    }
    this.emit({
      id: newUlid(),
      kind: "decision.proposed",
      actor: rec.author ?? "claude",
      project_id: this.projectId,
      created_at: Date.now(),
      payload: { decision_id: id, title: input.title, pr_number: input.pr_number ?? null },
    });
    return toDecision(rec);
  }

  /**
   * Transition a proposed decision into 'active'. Called by the PR service
   * when a PR that introduced the decision is merged. Idempotent: no-op if
   * the decision doesn't exist or isn't currently 'proposed'.
   */
  ratify(decisionId: string, viaPrNumber: number): void {
    const existing = this.decisions.get(decisionId);
    if (!existing || existing.status !== "proposed") return;
    this.update(decisionId, { status: "active" }, { emit: false });
    this.emit({
      id: newUlid(),
      kind: "decision.ratified",
      actor: existing.author ?? "claude",
      project_id: this.projectId,
      created_at: Date.now(),
      payload: { decision_id: decisionId, via_pr_number: viaPrNumber },
    });
  }

  linkRelatedTo(fromId: string, toId: string): void {
    this.addLink(fromId, "decision", toId, "DECISION_RELATED_TO", new Date().toISOString());
  }

  linkDependsOn(fromId: string, toId: string): void {
    this.addLink(fromId, "decision", toId, "DECISION_DEPENDS_ON", new Date().toISOString());
  }

  private addLink(
    decisionId: string, kind: TargetKind, ref: string, relation: Relation, createdAt: string,
  ): void {
    // Resolve seq-form or bare-seq owning ref to the canonical FK value so
    // `decision_links.decision_id` always stores the canonical PK (FK safe).
    const owner = this.resolveRecord(decisionId);
    const ownerId = owner ? owner.id : decisionId;

    // When the *target* is itself a decision (RELATED_TO, DEPENDS_ON, SUPERSEDES,
    // etc.), resolve it to canonical too so `target_ref` is stable.
    let targetRef = ref;
    if (kind === "decision") {
      const targetOwner = this.resolveRecord(ref);
      targetRef = targetOwner ? targetOwner.id : ref;
    }

    this.links.add({
      decision_id: ownerId, target_kind: kind, target_ref: targetRef,
      relation, created_at: createdAt,
    });
  }

  // Delete + insert must commit or roll back together: governance links are
  // the contract briefing, reconciliation, and `why` all key off, so a crash
  // mid-replacement must not leave a half-replaced set.
  private replaceLinks(
    decisionId: string,
    relation: "GOVERNS" | "REFERENCES",
    newTargets: string[],
    now: string,
  ): void {
    this.db.transaction(() => {
      const current = this.links.findByDecision(decisionId).filter((l) => l.relation === relation);
      const currentRefs = new Set(current.map((l) => l.target_ref));
      const newRefs = new Set(newTargets);

      const toRemove = current.filter((l) => !newRefs.has(l.target_ref));
      const toAdd = [...newRefs].filter((t) => !currentRefs.has(t));

      for (const link of toRemove) {
        this.links.remove(decisionId, link.target_kind, link.target_ref, link.relation);
      }
      for (const target of toAdd) {
        this.addLink(decisionId, classifyTarget(target), target, relation, now);
      }
    })();
  }

  private emit(event: Event): void { this.bus?.emit(event); }
}

function classifyTarget(target: string): TargetKind {
  return classifyGovernsTarget(target);
}

function toDecision(rec: DecisionRecord): Decision {
  return {
    id: rec.id,
    seq: rec.seq,
    title: rec.title,
    description: rec.description ?? "",
    rationale: rec.rationale ?? "",
    alternatives: rec.alternatives ? JSON.parse(rec.alternatives) : [],
    tier: rec.tier as Decision["tier"],
    status: rec.status as Decision["status"],
    superseded_by: rec.superseded_by,
    author: rec.author ?? "claude",
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    problem: rec.problem,
    resolution: rec.resolution,
    provenance: rec.provenance ? JSON.parse(rec.provenance) : null,
  };
}
