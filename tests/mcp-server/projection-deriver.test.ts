import { describe, it, expect } from "vitest";
import { deriveProjectionDeltas, type ProjectionSources } from "../../src/mcp-server/projection-deriver.js";
import type { Event } from "../../src/events/types.js";
import type { DecisionRecord } from "../../src/decisions/repository.js";
import type { TodoRecord } from "../../src/todos/types.js";

const DEC: DecisionRecord = {
  id: "dec_1", seq: 1, title: "T", description: null, rationale: "R", problem: null,
  resolution: null, alternatives: null, tier: "personal", status: "active",
  superseded_by: null, author: "claude", provenance: null,
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};
const TODO: TodoRecord = {
  id: "todo_1", seq: 1, summary: "S", description: null, state: "open", state_reason: null,
  proposed_by: "claude", proposed_at: "2026-07-01T00:00:00Z", started_at: null,
  closed_at: null, assignee: null, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};

function sources(over: Partial<ProjectionSources> = {}): ProjectionSources {
  return {
    decisions: { get: (id) => (id === "dec_1" ? DEC : null) },
    decisionLinks: { findByDecision: () => [] },
    todos: { get: (id) => (id === "todo_1" ? TODO : null) },
    todoLinks: { findByTodo: () => [], findBlocking: () => [] },
    pathIndices: () => ({ nodesByPath: new Map(), framesByPath: new Map() }),
    ...over,
  };
}

function env(kind: string, payload: unknown): Event {
  return { id: "01J0000000000000000000000A", kind, actor: "claude", created_at: 0, project_id: "p", payload } as Event;
}

describe("deriveProjectionDeltas", () => {
  it("decision.created → one decision upsert carrying the adapted shape, keyed by the event ULID", () => {
    const deltas = deriveProjectionDeltas(
      [env("decision.created", { decision_id: "dec_1", title: "T", rationale: "R", governed_file_ids: [], tags: [] })],
      sources(),
    );
    expect(deltas.length).toBe(1);
    expect(deltas[0]).toMatchObject({ ulid: "01J0000000000000000000000A", entity: "decision", op: "upsert" });
    expect((deltas[0].data as { summary: string }).summary).toBe("T"); // adapted shape, not the raw record
  });

  it("decision.deleted → remove", () => {
    const deltas = deriveProjectionDeltas([env("decision.deleted", { decision_id: "dec_1", title: "T" })], sources());
    expect(deltas[0]).toEqual({
      ulid: "01J0000000000000000000000A", entity: "decision", op: "remove", data: { id: "dec_1" },
    });
  });

  it("decision.superseded → upserts for BOTH old and new ids", () => {
    const deltas = deriveProjectionDeltas(
      [env("decision.superseded", { old_id: "dec_1", new_id: "dec_1", reason: "" })],
      sources(),
    );
    expect(deltas.length).toBe(2);
    expect(deltas.every((d) => d.op === "upsert" && d.entity === "decision")).toBe(true);
  });

  it("todo.transitioned → todo upsert (current adapted state)", () => {
    const deltas = deriveProjectionDeltas(
      [env("todo.transitioned", { todo_id: "todo_1", from: "open", to: "in_progress" })],
      sources(),
    );
    expect(deltas[0]).toMatchObject({ entity: "todo", op: "upsert" });
    expect((deltas[0].data as { state: string }).state).toBe("open"); // whatever the repo returns NOW
  });

  it("entity missing from the repo → skipped (a later delete in the log carries the remove)", () => {
    const deltas = deriveProjectionDeltas(
      [env("decision.updated", { decision_id: "dec_gone", changed_fields: [] })],
      sources(),
    );
    expect(deltas).toEqual([]);
  });

  it("commit and pr.* events → no projection deltas", () => {
    const deltas = deriveProjectionDeltas(
      [env("commit", { hash: "h", message: "m", files: [], decision_links: [] })],
      sources(),
    );
    expect(deltas).toEqual([]);
  });
});
