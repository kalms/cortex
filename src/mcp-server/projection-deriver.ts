/**
 * Projection deriver — the read-path sync engine's server stage.
 *
 * Maps each Event to zero-or-more ProjectionDeltas: full ADAPTED entity
 * shapes (the same buildAdaptedDecision/buildAdaptedTodo that serve
 * /api/decisions and /api/todos — one adapter, two transports), keyed by the
 * source event's ULID (the sync cursor).
 *
 * Reads the repos AT DERIVE TIME, so a delta always carries the entity's
 * current state. That makes catch-up replay state-converging: replaying an
 * old event range against today's DB yields today's shapes, and duplicate /
 * overlapping application is harmless (store upserts by id).
 *
 * Runs on the MAIN thread (the sidecar DBs + adapters live here), positioned
 * after the worker's persist and before WS fan-out.
 * See docs/architecture/viewer-sync-engine.md.
 */
import type { Event, ProjectionDelta } from "../events/types.js";
import type { NodeRow } from "../graph/store.js";
import type { DecisionRecord } from "../decisions/repository.js";
import type { DecisionLink } from "../decisions/links-repository.js";
import type { TodoRecord } from "../todos/types.js";
import type { TodoLink } from "../todos/links-repository.js";
import { buildAdaptedDecision, type FrameInfo } from "./api-decisions.js";
import { buildAdaptedTodo } from "./api-todos.js";

export interface ProjectionSources {
  decisions: { get(id: string): DecisionRecord | null };
  decisionLinks: { findByDecision(id: string): DecisionLink[] };
  todos: { get(id: string): TodoRecord | null };
  todoLinks: { findByTodo(id: string): TodoLink[]; findBlocking(id: string): TodoLink[] };
  /** Built per call batch — file-path → node / frame lookups for governs resolution. */
  pathIndices(): { nodesByPath: Map<string, NodeRow>; framesByPath: Map<string, FrameInfo> };
}

export function deriveProjectionDeltas(events: Event[], src: ProjectionSources): ProjectionDelta[] {
  const out: ProjectionDelta[] = [];
  let indices: ReturnType<ProjectionSources["pathIndices"]> | null = null;
  const idx = () => (indices ??= src.pathIndices());

  const upsertDecision = (ulid: string, id: string) => {
    const rec = src.decisions.get(id);
    if (!rec) return; // deleted since — a later remove in the log covers it
    const { nodesByPath, framesByPath } = idx();
    const data = buildAdaptedDecision(rec, src.decisionLinks.findByDecision(rec.id), nodesByPath, framesByPath);
    out.push({ ulid, entity: "decision", op: "upsert", data: data as unknown as Record<string, unknown> });
  };

  const upsertTodo = (ulid: string, id: string) => {
    const rec = src.todos.get(id);
    if (!rec) return;
    const { nodesByPath, framesByPath } = idx();
    const data = buildAdaptedTodo(
      rec, src.todoLinks.findByTodo(rec.id), src.todoLinks.findBlocking(rec.id), nodesByPath, framesByPath,
    );
    out.push({ ulid, entity: "todo", op: "upsert", data: data as unknown as Record<string, unknown> });
  };

  for (const e of events) {
    switch (e.kind) {
      case "decision.created":
      case "decision.updated":
      case "decision.promoted":
      case "decision.proposed":
      case "decision.ratified":
        upsertDecision(e.id, e.payload.decision_id);
        break;
      case "decision.superseded":
        upsertDecision(e.id, e.payload.old_id);
        upsertDecision(e.id, e.payload.new_id);
        break;
      case "decision.deleted":
        out.push({ ulid: e.id, entity: "decision", op: "remove", data: { id: e.payload.decision_id } });
        break;
      case "todo.proposed":
      case "todo.updated":
      case "todo.transitioned":
      case "todo.linked":
        upsertTodo(e.id, e.payload.todo_id);
        break;
      // commit / pr.* stay on the event + graph-mutation channels.
      default:
        break;
    }
  }
  return out;
}
