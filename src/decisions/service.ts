import { GraphStore, NodeRow } from "../graph/store.js";
import type { Decision, CreateDecisionInput, UpdateDecisionInput, ProposeDecisionInput } from "./types.js";
import { nodeToDecision } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";

export interface DecisionServiceDeps {
  bus?: EventBus;
  project_id?: string;
}

/**
 * DecisionService — CRUD over decisions with event emission.
 *
 * Each mutation emits exactly one event on the bus AFTER the SQLite write
 * succeeds. This ordering matters: a listener may assume the state reflected
 * by the event is already queryable via the graph store. If the write fails,
 * no event is emitted.
 *
 * `bus` is optional so existing call sites (tests, one-off scripts) continue
 * to work without backwards-incompatible changes.
 */
export class DecisionService {
  private bus: EventBus | undefined;
  private projectId: string;

  constructor(private store: GraphStore, deps: DecisionServiceDeps = {}) {
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? '';
  }

  create(input: CreateDecisionInput): Decision {
    const data = {
      title: input.title,
      description: input.description,
      rationale: input.rationale,
      alternatives: input.alternatives ?? [],
      status: "active" as const,
      author: input.author ?? 'claude',
      problem: input.problem ?? null,
      resolution: input.resolution ?? null,
    };

    const node = this.store.createNode({
      kind: "decision",
      name: input.title,
      data,
      tier: "personal",
    });

    this.store.indexDecisionContent(node.id, input.title, {
      description: data.description,
      rationale: data.rationale,
      problem: data.problem,
      resolution: data.resolution,
    });

    const governedIds: string[] = [];
    if (input.governs) {
      for (const target of input.governs) {
        const id = this.linkGovernsReturningTarget(node.id, target);
        governedIds.push(id);
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

    this.emit({
      id: newUlid(),
      kind: 'decision.created',
      actor: data.author,
      created_at: Date.now(),
      project_id: this.projectId,
      payload: {
        decision_id: node.id,
        title: input.title,
        rationale: input.rationale,
        governed_file_ids: governedIds,
        tags: [],
      },
    });

    return nodeToDecision(node);
  }

  /**
   * Same as linkGoverns but returns the target node id (resolving path-to-node
   * if necessary). Used by create() to build the governed_file_ids payload.
   */
  private linkGovernsReturningTarget(decisionId: string, target: string): string {
    const existingNode = this.store.getNode(target);
    if (existingNode) {
      this.store.createEdge({
        source_id: decisionId,
        target_id: target,
        relation: "GOVERNS",
      });
      return target;
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
    return pathNode.id;
  }

  linkGoverns(decisionId: string, target: string): void {
    this.linkGovernsReturningTarget(decisionId, target);
  }

  linkReference(decisionId: string, targetId: string): void {
    this.store.createEdge({
      source_id: decisionId,
      target_id: targetId,
      relation: "REFERENCES",
    });
  }

  update(id: string, input: UpdateDecisionInput): Decision {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const existingData = JSON.parse(node.data);
    const newData = { ...existingData };
    const changed: string[] = [];

    if (input.title !== undefined && input.title !== existingData.title) { newData.title = input.title; changed.push('title'); }
    if (input.description !== undefined && input.description !== existingData.description) { newData.description = input.description; changed.push('description'); }
    if (input.rationale !== undefined && input.rationale !== existingData.rationale) { newData.rationale = input.rationale; changed.push('rationale'); }
    if (input.alternatives !== undefined) { newData.alternatives = input.alternatives; changed.push('alternatives'); }
    if (input.status !== undefined && input.status !== existingData.status) { newData.status = input.status; changed.push('status'); }
    if (input.superseded_by !== undefined) { newData.superseded_by = input.superseded_by; changed.push('superseded_by'); }
    if (input.problem !== undefined) { newData.problem = input.problem; changed.push('problem'); }
    if (input.resolution !== undefined) { newData.resolution = input.resolution; changed.push('resolution'); }

    const updatedNode = this.store.updateNode(id, {
      name: newData.title,
      data: JSON.stringify(newData),
    });

    this.store.updateDecisionContent(id, newData.title, {
      description: newData.description,
      rationale: newData.rationale,
      problem: newData.problem,
      resolution: newData.resolution,
    });

    if (input.superseded_by) {
      const existing = this.store.findEdges({ source_id: input.superseded_by, target_id: id, relation: "SUPERSEDES" });
      if (existing.length === 0) {
        this.store.createEdge({
          source_id: input.superseded_by,
          target_id: id,
          relation: "SUPERSEDES",
        });
      }
      this.emit({
        id: newUlid(),
        kind: 'decision.superseded',
        actor: newData.author ?? 'claude',
        created_at: Date.now(),
        project_id: this.projectId,
        payload: { old_id: id, new_id: input.superseded_by, reason: input.reason ?? '' },
      });
    } else if (changed.length > 0) {
      this.emit({
        id: newUlid(),
        kind: 'decision.updated',
        actor: newData.author ?? 'claude',
        created_at: Date.now(),
        project_id: this.projectId,
        payload: { decision_id: id, changed_fields: changed },
      });
    }

    return nodeToDecision(updatedNode);
  }

  delete(id: string): void {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const titleSnapshot = JSON.parse(node.data).title as string;

    this.store.removeDecisionContent(id);
    this.store.deleteNode(id);

    this.emit({
      id: newUlid(),
      kind: 'decision.deleted',
      actor: 'claude',
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, title: titleSnapshot },
    });
  }

  get(id: string): Decision & { governs: NodeRow[]; references: NodeRow[] } {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const decision = nodeToDecision(node);

    const governsEdges = this.store.findEdges({ source_id: id, relation: "GOVERNS" });
    const governs = governsEdges
      .map((e) => this.store.getNode(e.target_id))
      .filter((n): n is NodeRow => n !== undefined);

    const referencesEdges = this.store.findEdges({ source_id: id, relation: "REFERENCES" });
    const references = referencesEdges
      .map((e) => this.store.getNode(e.target_id))
      .filter((n): n is NodeRow => n !== undefined);

    return { ...decision, governs, references };
  }

  propose(input: ProposeDecisionInput): Decision {
    const data: Record<string, unknown> = {
      title: input.title,
      description: input.resolution,
      rationale: input.rationale,
      alternatives: input.alternatives ?? [],
      author: input.author ?? 'claude',
      status: "proposed",
      superseded_by: null,
      problem: input.problem,
      resolution: input.resolution,
    };
    const node = this.store.createNode({ kind: "decision", name: input.title, data, tier: "personal" });
    this.store.indexDecisionContent(node.id, input.title, {
      description: input.resolution,
      rationale: input.rationale,
      problem: input.problem,
      resolution: input.resolution,
    });
    for (const target of input.governs ?? []) this.linkGoverns(node.id, target);
    for (const ref of input.references ?? []) this.linkReference(node.id, ref);
    if (input.pr_number != null) {
      const prNode = this.findPrByNumber(input.pr_number);
      if (prNode) {
        this.store.createEdge({
          source_id: prNode.id,
          target_id: node.id,
          relation: "PR_INTRODUCES_DECISION",
        });
      }
    }
    this.emit({
      id: newUlid(),
      kind: 'decision.proposed',
      actor: (data.author as string),
      project_id: this.projectId,
      created_at: Date.now(),
      payload: {
        decision_id: node.id,
        title: input.title,
        pr_number: input.pr_number ?? null,
      },
    });
    return nodeToDecision(node);
  }

  private findPrByNumber(num: number): { id: string } | null {
    const row = (this.store as any).db
      .prepare(
        `SELECT id FROM nodes WHERE kind = 'pull_request'
         AND CAST(json_extract(data, '$.number') AS INTEGER) = ?`
      )
      .get(num) as { id: string } | undefined;
    return row ?? null;
  }

  private emit(event: Event): void {
    this.bus?.emit(event);
  }
}
