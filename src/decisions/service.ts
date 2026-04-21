import { GraphStore, NodeRow } from "../graph/store.js";
import type { Decision, CreateDecisionInput, UpdateDecisionInput, ProposeDecisionInput, SupersedeDecisionInput, DecisionWithRefs, PRRef } from "./types.js";
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
    if (input.author !== undefined) { newData.author = input.author; changed.push('author'); }

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

  supersede(input: SupersedeDecisionInput): Decision {
    return this.store.transaction(() => {
      const oldNode = this.store.getNode(input.old_decision_id);
      if (!oldNode || oldNode.kind !== "decision") {
        throw new Error(`Decision not found: ${input.old_decision_id}`);
      }
      const created = this.create({
        title: input.title,
        description: input.resolution,
        rationale: input.rationale,
        alternatives: input.alternatives,
        governs: input.governs,
        references: input.references,
        author: input.author,
        problem: input.problem,
        resolution: input.resolution,
      });
      this.update(input.old_decision_id, {
        status: "superseded",
        superseded_by: created.id,
        author: input.author,
      });
      return created;
    });
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

  linkRelatedTo(fromId: string, toId: string): void {
    this.requireDecisions(fromId, toId);
    this.store.createEdge({ source_id: fromId, target_id: toId, relation: "DECISION_RELATED_TO" });
  }

  linkDependsOn(fromId: string, toId: string): void {
    this.requireDecisions(fromId, toId);
    this.store.createEdge({ source_id: fromId, target_id: toId, relation: "DECISION_DEPENDS_ON" });
  }

  private requireDecisions(...ids: string[]): void {
    for (const id of ids) {
      const n = this.store.getNode(id);
      if (!n || n.kind !== "decision") throw new Error(`Decision not found: ${id}`);
    }
  }

  getWithRefs(id: string): DecisionWithRefs | null {
    const node = this.store.getNode(id);
    if (!node || node.kind !== "decision") return null;
    const base = nodeToDecision(node);

    const outgoing = this.store.findEdges({ source_id: id });
    const incoming = this.store.findEdges({ target_id: id });

    const related = [
      ...outgoing.filter((e) => e.relation === "DECISION_RELATED_TO"),
      ...incoming.filter((e) => e.relation === "DECISION_RELATED_TO"),
    ];
    const deps = outgoing.filter((e) => e.relation === "DECISION_DEPENDS_ON");
    const prIntro = incoming.filter((e) => e.relation === "PR_INTRODUCES_DECISION");
    const prImpl = incoming.filter((e) => e.relation === "PR_IMPLEMENTS_DECISION");
    const prChal = incoming.filter((e) => e.relation === "PR_CHALLENGES_DECISION");
    const prDisc = incoming.filter((e) => e.relation === "PR_DISCUSSES_DECISION");

    return {
      ...base,
      related_decisions: related
        .map((e) => (e.source_id === id ? e.target_id : e.source_id))
        .map((otherId) => this.store.getNode(otherId))
        .filter((n): n is NonNullable<typeof n> => !!n && n.kind === "decision")
        .map((n) => nodeToDecision(n)),
      depends_on: deps
        .map((e) => this.store.getNode(e.target_id))
        .filter((n): n is NonNullable<typeof n> => !!n && n.kind === "decision")
        .map((n) => nodeToDecision(n)),
      introduced_in: this.firstPrRef(prIntro),
      implemented_by: this.prRefsFromEdges(prImpl),
      challenged_by: this.prRefsFromEdges(prChal),
      discussed_in: this.prRefsFromEdges(prDisc),
    };
  }

  private firstPrRef(edges: Array<{ source_id: string }>): PRRef | null {
    const refs = this.prRefsFromEdges(edges);
    return refs[0] ?? null;
  }

  private prRefsFromEdges(edges: Array<{ source_id: string }>): PRRef[] {
    return edges
      .map((e) => this.store.getNode(e.source_id))
      .filter((n): n is NonNullable<typeof n> => !!n && n.kind === "pull_request")
      .map((n) => {
        const data = JSON.parse(n.data || "{}");
        return { number: data.number, title: n.name, state: data.state };
      });
  }

  ratify(decisionId: string, viaPrNumber: number): void {
    const node = this.store.getNode(decisionId);
    if (!node || node.kind !== "decision") throw new Error(`Decision not found: ${decisionId}`);
    const data = typeof node.data === "string" ? JSON.parse(node.data || "{}") : node.data;
    if (data.status !== "proposed") return;
    data.status = "active";
    this.store.updateNode(decisionId, { data: JSON.stringify(data) });
    this.store.updateDecisionContent(decisionId, node.name, {
      description: data.description,
      rationale: data.rationale,
      problem: data.problem,
      resolution: data.resolution,
    });
    this.emit({
      id: newUlid(),
      kind: "decision.ratified",
      actor: data.author ?? "claude",
      project_id: this.projectId,
      created_at: Date.now(),
      payload: { decision_id: decisionId, via_pr_number: viaPrNumber },
    });
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
