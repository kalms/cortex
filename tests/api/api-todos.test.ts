// tests/api/api-todos.test.ts
import { describe, it, expect } from "vitest";
import { buildAdaptedTodo } from "../../src/mcp-server/api-todos.js";

const baseRec = {
  id: "T-9m2x", seq: 3, summary: "migrate", description: "body", state: "open",
  state_reason: null, proposed_by: "rka", proposed_at: "t", started_at: null,
  closed_at: null, assignee: null, created_at: "t", updated_at: "t",
};

describe("buildAdaptedTodo", () => {
  it("maps record + links to the wire shape", () => {
    const links = [
      { todo_id: "T-9m2x", target_kind: "todo", target_ref: "T-bbbb", relation: "BLOCKED_BY", created_at: "t" },
      { todo_id: "T-9m2x", target_kind: "decision", target_ref: "D-zzzz", relation: "SPAWNS_FROM", created_at: "t" },
      { todo_id: "T-9m2x", target_kind: "pr", target_ref: "42", relation: "RESOLVED_BY", created_at: "t" },
    ] as any;
    const t = buildAdaptedTodo(baseRec as any, links, [], new Map(), new Map());
    expect(t.spawnsFrom).toBe("D-zzzz");
    expect(t.blockedBy).toEqual([{ kind: "todo", id: "T-bbbb" }]);
    expect(t.resolvedBy).toEqual(["42"]);
  });

  it("derives blocks from blockingLinks (reverse BLOCKED_BY)", () => {
    const links: any[] = [];
    const blockingLinks = [
      { todo_id: "T-aaaa", target_kind: "todo", target_ref: "T-9m2x", relation: "BLOCKED_BY", created_at: "t" },
      { todo_id: "T-cccc", target_kind: "todo", target_ref: "T-9m2x", relation: "BLOCKED_BY", created_at: "t" },
      // this one should be ignored - different target
      { todo_id: "T-dddd", target_kind: "todo", target_ref: "T-zzzz", relation: "BLOCKED_BY", created_at: "t" },
    ] as any;
    const t = buildAdaptedTodo(baseRec as any, links, blockingLinks, new Map(), new Map());
    expect(t.blocks).toEqual([
      { kind: "todo", id: "T-aaaa" },
      { kind: "todo", id: "T-cccc" },
    ]);
  });

  it("resolves GOVERNS path link via nodesByPath + framesByPath", () => {
    const links = [
      { todo_id: "T-9m2x", target_kind: "path", target_ref: "src/graph/store.ts", relation: "GOVERNS", created_at: "t" },
    ] as any;
    const nodesByPath = new Map([["src/graph/store.ts", {} as any]]);
    const framesByPath = new Map([["src/graph/store.ts", { frame_id: 3, frame_label: "graph" }]]);
    const t = buildAdaptedTodo(baseRec as any, links, [], nodesByPath, framesByPath);
    expect(t.governs).toEqual([
      { kind: "frame", id: "3", label: "graph" },
      { kind: "file", path: "src/graph/store.ts" },
    ]);
  });

  it("resolves GOVERNS qn link to function ref when file is in a frame", () => {
    const links = [
      { todo_id: "T-9m2x", target_kind: "qn", target_ref: "src/graph/store.ts::insertNode", relation: "GOVERNS", created_at: "t" },
    ] as any;
    const nodesByPath = new Map([["src/graph/store.ts", {} as any]]);
    const framesByPath = new Map([["src/graph/store.ts", { frame_id: 3, frame_label: "graph" }]]);
    const t = buildAdaptedTodo(baseRec as any, links, [], nodesByPath, framesByPath);
    expect(t.governs).toEqual([
      { kind: "frame", id: "3", label: "graph" },
      { kind: "function", path: "src/graph/store.ts", name: "insertNode" },
    ]);
  });

  it("handles RELATED_TO link", () => {
    const links = [
      { todo_id: "T-9m2x", target_kind: "todo", target_ref: "T-yyyy", relation: "RELATED_TO", created_at: "t" },
    ] as any;
    const t = buildAdaptedTodo(baseRec as any, links, [], new Map(), new Map());
    expect(t.relatedTo).toEqual([{ kind: "todo", id: "T-yyyy" }]);
  });

  it("maps record fields to camelCase wire fields", () => {
    const t = buildAdaptedTodo(baseRec as any, [], [], new Map(), new Map());
    expect(t.proposedBy).toBe("rka");
    expect(t.proposedAt).toBe("t");
    expect(t.startedAt).toBeNull();
    expect(t.closedAt).toBeNull();
    expect(t.assignee).toBeNull();
    expect(t.description).toBe("body");
    expect(t.seq).toBe(3);
    expect(t.id).toBe("T-9m2x");
  });

  it("ignores links for other todo ids", () => {
    const links = [
      { todo_id: "T-other", target_kind: "decision", target_ref: "D-zzzz", relation: "SPAWNS_FROM", created_at: "t" },
    ] as any;
    const t = buildAdaptedTodo(baseRec as any, links, [], new Map(), new Map());
    expect(t.spawnsFrom).toBeNull();
  });
});
