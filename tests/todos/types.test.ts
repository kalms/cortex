import { describe, it, expect } from "vitest";
import { rowToTodo, type TodoState } from "../../src/todos/types.js";

describe("rowToTodo", () => {
  it("maps a DB row to a Todo, defaulting nullable link arrays empty", () => {
    const t = rowToTodo({
      id: "T-9m2x", seq: 3, summary: "migrate auth", description: "to OAuth",
      state: "open", state_reason: null, proposed_by: "rka",
      proposed_at: "2026-06-23T00:00:00.000Z", started_at: null, closed_at: null,
      assignee: null, created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    });
    expect(t.id).toBe("T-9m2x");
    expect(t.seq).toBe(3);
    expect(t.state).toBe<TodoState>("open");
    expect(t.summary).toBe("migrate auth");
    expect(t.assignee).toBeNull();
  });
});
