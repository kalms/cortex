import { describe, it, expect } from "vitest";
import { groupCheckouts } from "../../src/graph/group-checkouts.js";

const main = { root_path: "/r/main", worktree_of: null, branch: null };
const wtX = { root_path: "/r/wt-x", worktree_of: "/r/main", branch: "feature/x" };
const wtY = { root_path: "/r/wt-y", worktree_of: "/r/main", branch: "feature/y" };

describe("groupCheckouts", () => {
  it("nests worktree rows under their parent", () => {
    const out = groupCheckouts([main, wtX, wtY]);
    expect(out).toHaveLength(1);
    expect(out[0].root_path).toBe("/r/main");
    expect(out[0].worktrees.map((w) => w.branch).sort()).toEqual(["feature/x", "feature/y"]);
  });

  it("gives a main checkout an empty worktrees array", () => {
    expect(groupCheckouts([main])[0].worktrees).toEqual([]);
  });

  it("keeps an orphaned worktree top-level rather than dropping it", () => {
    const out = groupCheckouts([wtX]);
    expect(out).toHaveLength(1);
    expect(out[0].root_path).toBe("/r/wt-x");
  });

  it("preserves input order of parents", () => {
    const other = { root_path: "/r/other", worktree_of: null, branch: null };
    expect(groupCheckouts([other, main, wtX]).map((p) => p.root_path)).toEqual(["/r/other", "/r/main"]);
  });
});
