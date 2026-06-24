/**
 * Adapter: TodoRecord + TodoLink rows from the todos sidecar DB
 * into the wire shape the HTTP API serves (AdaptedTodo).
 *
 * Pure functions — fully unit-testable, no IO or DB access.
 * `resolveGovernsRef` is reused from api-decisions.ts (shared GOVERNS logic).
 */
import type { NodeRow } from "../graph/store.js";
import type { TodoRecord } from "../todos/types.js";
import type { TodoLink } from "../todos/links-repository.js";
import type { GovernsRef, AdaptedTodo } from "./api-schemas.js";
import { resolveGovernsRef, type FrameInfo } from "./api-decisions.js";

export function buildAdaptedTodo(
  rec: TodoRecord,
  links: TodoLink[],
  blockingLinks: TodoLink[],          // reverse BLOCKED_BY → derived `blocks`
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): AdaptedTodo {
  const governs: GovernsRef[] = [];
  const blockedBy: { kind: string; id: string }[] = [];
  const relatedTo: { kind: string; id: string }[] = [];
  const resolvedBy: string[] = [];
  let spawnsFrom: string | null = null;

  for (const l of links) {
    if (l.todo_id !== rec.id) continue;
    switch (l.relation) {
      case "GOVERNS":
        governs.push(...resolveGovernsRef(l, nodesByPath, framesByPath));
        break;
      case "BLOCKED_BY":
        blockedBy.push({ kind: "todo", id: l.target_ref });
        break;
      case "RELATED_TO":
        relatedTo.push({ kind: "todo", id: l.target_ref });
        break;
      case "SPAWNS_FROM":
        spawnsFrom = l.target_ref;
        break;
      case "RESOLVED_BY":
        resolvedBy.push(l.target_ref);
        break;
    }
  }

  // `blocks` is derived: reverse side of BLOCKED_BY — other todos that name
  // this todo as their blocker (passed in by the route layer).
  const blocks = blockingLinks
    .filter((l) => l.target_ref === rec.id)
    .map((l) => ({ kind: "todo", id: l.todo_id }));

  return {
    id: rec.id,
    seq: rec.seq ?? null,
    summary: rec.summary,
    description: rec.description ?? "",
    state: rec.state,
    proposedBy: rec.proposed_by ?? null,
    proposedAt: rec.proposed_at,
    startedAt: rec.started_at ?? null,
    closedAt: rec.closed_at ?? null,
    assignee: rec.assignee ?? null,
    governs,
    blockedBy,
    blocks,
    relatedTo,
    spawnsFrom,
    resolvedBy,
  };
}

export function buildAdaptedTodos(
  recs: TodoRecord[],
  links: TodoLink[],
  blockingLinks: TodoLink[],
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): AdaptedTodo[] {
  return recs.map((r) => buildAdaptedTodo(r, links, blockingLinks, nodesByPath, framesByPath));
}
