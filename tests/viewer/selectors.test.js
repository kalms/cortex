import { describe, it, expect } from "vitest";
import { fileCardData, resolveTodo } from "../../src/viewer/app/drawer/selectors.ts";

const nodes = [
  { id: "fa", kind: "file", name: "a.ts", file_path: "src/a.ts", data: "{}" },
  { id: "fb", kind: "file", name: "b.ts", file_path: "src/b.ts", data: "{}" },
  { id: "fc", kind: "file", name: "c.ts", file_path: "src/c.ts", data: "{}" },
  { id: "s1", kind: "function", name: "doThing", file_path: "src/a.ts", data: "{}" },
  { id: "s2", kind: "class", name: "Thing", file_path: "src/a.ts", data: "{}" },
];
const edges = [
  { source: "fb", target: "fa", relation: "IMPORTS" },
  { source: "fc", target: "fa", relation: "CALLS" },
  { source: "fc", target: "fa", relation: "CALLS" },
  { source: "fa", target: "fb", relation: "CALLS" },
  { source: "fa", target: "fc", relation: "FILE_CHANGES_WITH" },
];
const bundle = {
  rawNodes: nodes, rawEdges: edges,
  framePathIndex: new Map([["src/a.ts", "1"]]),
  frames: [{ id: "1", name: "alpha", layer: "domain" }],
  decisions: [{ id: "d1", summary: "governs a", governs: [{ kind: "file", path: "src/a.ts" }] }],
  allTodos: [{ id: "t1", summary: "todo a", state: "proposed", governs: [{ kind: "file", path: "src/a.ts" }] }],
};

describe("fileCardData", () => {
  const card = fileCardData(bundle, "src/a.ts");
  it("resolves frame + layer", () => {
    expect(card.frameName).toBe("alpha");
    expect(card.layer).toBe("domain");
  });
  it("counts file-level fan-in/out from CALLS+IMPORTS", () => {
    expect(card.fanIn).toBe(3);
    expect(card.fanOut).toBe(1);
  });
  it("ranks inbound connections by count", () =>
    expect(card.connectionsIn).toEqual([{ path: "src/c.ts", count: 2 }, { path: "src/b.ts", count: 1 }]));
  it("lists symbols defined in the file (files excluded)", () =>
    expect(card.symbols.map((s) => s.name).sort()).toEqual(["Thing", "doThing"]));
  it("finds co-change partners", () => expect(card.coChange).toEqual([{ path: "src/c.ts" }]));
  it("collects governing decisions and related todos", () => {
    expect(card.decisions.map((d) => d.id)).toEqual(["d1"]);
    expect(card.todos.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("resolveTodo", () => {
  const ambientTodo = { id: "t1", state: "proposed" };
  const closedTodo = { id: "t2", state: "done" };
  const removedSnap = { id: "t3", state: "proposed" };
  const ambient = { t1: ambientTodo };
  const allTodos = [ambientTodo, closedTodo];
  const removed = { t3: removedSnap };

  it("resolves an ambient (live) todo with isRemoved false", () => {
    expect(resolveTodo(ambient, allTodos, removed, "t1")).toEqual({ todo: ambientTodo, isRemoved: false });
  });

  it("resolves a closed todo (state done) found only in allTodos, isRemoved false", () => {
    expect(resolveTodo(ambient, allTodos, removed, "t2")).toEqual({ todo: closedTodo, isRemoved: false });
  });

  it("resolves a todo found only in the removed-snapshots map, isRemoved true", () => {
    expect(resolveTodo(ambient, allTodos, removed, "t3")).toEqual({ todo: removedSnap, isRemoved: true });
  });
});
