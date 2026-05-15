import { randomUUID } from "node:crypto";
import type { Decision, CreateDecisionInput, UpdateDecisionInput, ProposeDecisionInput, SupersedeDecisionInput, DecisionWithRefs } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository, TargetKind, Relation } from "./links-repository.js";

export interface DecisionServiceDeps {
  decisions: DecisionsRepository;
  links: DecisionLinksRepository;
  bus?: EventBus;
  project_id?: string;
}

export class DecisionService {
  private decisions: DecisionsRepository;
  private links: DecisionLinksRepository;
  private bus: EventBus | undefined;
  private projectId: string;

  constructor(deps: DecisionServiceDeps) {
    this.decisions = deps.decisions;
    this.links = deps.links;
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? "";
  }

  create(input: CreateDecisionInput): Decision {
    const now = new Date().toISOString();
    const id = randomUUID();
    const rec: DecisionRecord = {
      id,
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

  get(id: string): Decision | null {
    const rec = this.decisions.get(id);
    return rec ? toDecision(rec) : null;
  }

  update(id: string, input: UpdateDecisionInput): Decision {
    const existing = this.decisions.get(id);
    if (!existing) throw new Error(`Decision not found: ${id}`);
    const now = new Date().toISOString();
    const patch: Partial<DecisionRecord> = { updated_at: now };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.rationale !== undefined) patch.rationale = input.rationale;
    if (input.alternatives !== undefined)
      patch.alternatives = JSON.stringify(input.alternatives);
    if (input.status !== undefined) patch.status = input.status;
    if (input.superseded_by !== undefined) patch.superseded_by = input.superseded_by;
    if (input.problem !== undefined) patch.problem = input.problem;
    if (input.resolution !== undefined) patch.resolution = input.resolution;
    if (input.author !== undefined) patch.author = input.author;
    this.decisions.update(id, patch);
    return toDecision({ ...existing, ...patch } as DecisionRecord);
  }

  delete(id: string): void {
    if (!this.decisions.delete(id)) throw new Error(`Decision not found: ${id}`);
    this.emit({
      id: newUlid(),
      kind: "decision.deleted",
      actor: "claude",
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, title: "" },
    });
  }

  search(query: string): Decision[] {
    return this.decisions.search(query).map(toDecision);
  }

  linkGoverns(decisionId: string, target: string): void {
    this.addLink(decisionId, classifyTarget(target), target, "GOVERNS", new Date().toISOString());
  }

  linkReference(decisionId: string, target: string): void {
    this.addLink(decisionId, classifyTarget(target), target, "REFERENCES", new Date().toISOString());
  }

  private addLink(
    decisionId: string, kind: TargetKind, ref: string, relation: Relation, createdAt: string,
  ): void {
    this.links.add({
      decision_id: decisionId, target_kind: kind, target_ref: ref,
      relation, created_at: createdAt,
    });
  }

  private emit(event: Event): void { this.bus?.emit(event); }
}

function classifyTarget(target: string): TargetKind {
  return target.includes("/") ? "path" : "qn";
}

function toDecision(rec: DecisionRecord): Decision {
  return {
    id: rec.id,
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
  };
}
