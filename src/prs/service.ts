import type { GraphStore } from "../graph/store.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";
import type { DecisionLinksRepository } from "../decisions/links-repository.js";
import type {
  PullRequest,
  OpenPRInput,
  AddPRTouchInput,
  PullRequestWithRefs,
  PRTouch,
} from "./types.js";

export interface EventBus {
  emit(event: Event): void;
}

export interface PRServiceDeps {
  bus?: EventBus;
  default_actor?: string;
  project_id?: string;
  decisions?: import("../decisions/service.js").DecisionService;
  links?: DecisionLinksRepository;
}

export class PRService {
  private bus?: EventBus;
  private defaultActor: string;
  private projectId: string;
  private decisions?: import("../decisions/service.js").DecisionService;
  private links?: DecisionLinksRepository;

  constructor(private store: GraphStore, deps: PRServiceDeps = {}) {
    this.bus = deps.bus;
    this.defaultActor = deps.default_actor ?? "system";
    this.projectId = deps.project_id ?? "";
    this.decisions = deps.decisions;
    this.links = deps.links;
  }

  open(input: OpenPRInput): PullRequest {
    return this.store.transaction(() => {
      const number = this.allocateNumber();
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const data = {
        number,
        state: input.state ?? "open",
        author: input.author,
        opened_at: nowIso,
        merged_at: null as string | null,
        closed_at: null as string | null,
        branch: input.branch ?? null,
        description: input.description ?? null,
        introduces_frame: input.introduces_frame ?? null,
        additions: input.additions ?? 0,
        comment_count: 0,
        last_activity_at: nowIso,
        source: input.source ?? "native",
        external_ref: input.external_ref ?? null,
        last_synced_at: null as string | null,
        touches: [] as PRTouch[],
      };
      const node = this.store.createNode({ kind: "pull_request", name: input.title, data });
      this.emit({
        id: newUlid(),
        kind: "pr.opened",
        actor: this.defaultActor,
        project_id: this.projectId,
        created_at: now,
        payload: {
          pr_number: number,
          title: input.title,
          author: input.author ?? null,
          state: data.state,
          source: data.source,
        },
      });
      return this.nodeToPr(node);
    });
  }

  addTouch(input: AddPRTouchInput): void {
    this.store.transaction(() => {
      const node = this.findByNumber(input.pr_number);
      if (!node) throw new Error(`PR not found: #${input.pr_number}`);
      const data = JSON.parse(node.data || "{}");
      const touches: PRTouch[] = data.touches ?? [];
      const exists = touches.some(
        (t) =>
          t.frame_id === input.frame_id &&
          t.node_name === input.node_name &&
          t.action === input.action
      );
      if (exists) return;
      touches.push({ frame_id: input.frame_id, node_name: input.node_name, action: input.action });
      data.touches = touches;
      this.store.updateNode(node.id, { data: JSON.stringify(data) });
      this.emit({
        id: newUlid(),
        kind: "pr.touched",
        actor: this.defaultActor,
        project_id: this.projectId,
        created_at: Date.now(),
        payload: {
          pr_number: input.pr_number,
          frame_id: input.frame_id,
          node_name: input.node_name,
          action: input.action,
        },
      });
    });
  }

  get(number: number): PullRequest | null {
    const node = this.findByNumber(number);
    return node ? this.nodeToPr(node) : null;
  }

  merge(number: number): { pr_number: number; ratified_decisions: string[] } {
    return this.store.transaction(() => {
      const node = this.findByNumber(number);
      if (!node) throw new Error(`PR not found: #${number}`);
      const data = JSON.parse(node.data || "{}");
      if (data.state === "merged") throw new Error(`PR #${number} already merged`);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      data.state = "merged";
      data.merged_at = nowIso;
      data.last_activity_at = nowIso;
      this.store.updateNode(node.id, { data: JSON.stringify(data) });

      // find introduced decisions still proposed — links live in the
      // decisions sidecar's decision_links table keyed by (pr, number).
      const ratified: string[] = [];
      if (this.links && this.decisions) {
        const introLinks = this.links.findByTarget(
          "pr",
          String(number),
          "PR_INTRODUCES_DECISION",
        );
        for (const link of introLinks) {
          const dec = this.decisions.get(link.decision_id);
          if (!dec) continue;
          if (dec.status === "proposed") {
            this.decisions.ratify(link.decision_id, number);
            ratified.push(link.decision_id);
          }
        }
      }

      this.emit({
        id: newUlid(),
        kind: "pr.merged",
        actor: this.defaultActor,
        project_id: this.projectId,
        created_at: now,
        payload: { pr_number: number, ratified_decisions: ratified },
      });
      return { pr_number: number, ratified_decisions: ratified };
    });
  }

  getWithRefs(number: number): PullRequestWithRefs | null {
    const base = this.get(number);
    if (!base) return null;
    const outEdges = this.store.findEdges({ source_id: base.id });

    // PR <-> decision links now live in the decisions sidecar's
    // decision_links table, keyed by target_kind='pr' and target_ref=String(number).
    const decisionLinks = this.links
      ? this.links.findByTarget("pr", String(number))
      : [];
    const pickDecisions = (relation: string): string[] =>
      decisionLinks
        .filter((l) => l.relation === relation)
        .map((l) => l.decision_id);

    const linkedPrs = outEdges
      .filter((e) => e.relation === "PR_LINK_DEPENDS_ON" || e.relation === "PR_LINK_RELATED_TO")
      .map((e) => {
        const target = this.store.getNode(e.target_id);
        const td = target ? JSON.parse(target.data || "{}") : {};
        return {
          relation: (e.relation === "PR_LINK_DEPENDS_ON" ? "depends_on" : "related_to") as
            | "depends_on"
            | "related_to",
          pr_number: td.number,
        };
      });

    return {
      ...base,
      introduces_decisions: pickDecisions("PR_INTRODUCES_DECISION"),
      implements_decisions: pickDecisions("PR_IMPLEMENTS_DECISION"),
      challenges_decisions: pickDecisions("PR_CHALLENGES_DECISION"),
      discusses_decisions: pickDecisions("PR_DISCUSSES_DECISION"),
      linked_prs: linkedPrs,
    };
  }

  private allocateNumber(): number {
    const row = (this.store as any).db
      .prepare(
        `SELECT COALESCE(MAX(CAST(json_extract(data, '$.number') AS INTEGER)), 0) + 1 AS n
         FROM nodes WHERE kind = 'pull_request'`
      )
      .get() as { n: number };
    return row.n;
  }

  private findByNumber(
    num: number
  ): { id: string; name: string; data: string; kind: string } | null {
    const row = (this.store as any).db
      .prepare(
        `SELECT id, name, data, kind FROM nodes WHERE kind = 'pull_request'
         AND CAST(json_extract(data, '$.number') AS INTEGER) = ?`
      )
      .get(num) as { id: string; name: string; data: string; kind: string } | undefined;
    return row ?? null;
  }

  private nodeToPr(node: {
    id: string;
    name: string;
    data: string | Record<string, unknown>;
  }): PullRequest {
    const raw =
      typeof node.data === "string"
        ? JSON.parse(node.data || "{}")
        : (node.data ?? {});
    return {
      id: node.id,
      number: raw.number,
      title: node.name,
      state: raw.state,
      author: raw.author ?? null,
      opened_at: raw.opened_at,
      merged_at: raw.merged_at ?? null,
      closed_at: raw.closed_at ?? null,
      branch: raw.branch ?? null,
      description: raw.description ?? null,
      introduces_frame: raw.introduces_frame ?? null,
      additions: raw.additions ?? 0,
      comment_count: raw.comment_count ?? 0,
      last_activity_at: raw.last_activity_at ?? null,
      source: raw.source ?? "native",
      external_ref: raw.external_ref ?? null,
      last_synced_at: raw.last_synced_at ?? null,
      touches: raw.touches ?? [],
    };
  }

  private emit(event: Event): void {
    this.bus?.emit(event);
  }
}
