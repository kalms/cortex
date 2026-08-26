// MCP contract tests for the `branch`/`thread` filters on `decision({action:
// "search"})` and `todo({action:"list"|"search"})` (Task 11 — the MCP-tool
// counterpart of Task 10's HTTP `?branch=`/`?thread=` filters).
//
// Semantics under test, identical to Task 10 and taken from the spec: exact
// match on origin_branch/origin_thread; an absent filter preserves today's
// (unfiltered) behavior exactly, including rows with no recorded origin; a
// filter never matches a NULL origin — a row with no recorded origin is not
// "on" any branch/thread.
//
// The harness's fixture repo is a bare `git init` with zero commits, so
// `gitBranch()` (src/git/worktree-state.ts) returns null for it — every
// decision/todo created through `callTool` therefore gets origin_branch=NULL
// for free. To exercise the filter we stamp distinct origin_branch/
// origin_thread values directly via SQL on some of the seeded rows, leaving
// others NULL, exactly as tests/api/provenance-filters.test.ts (Task 10) and
// tests/mcp-contract/todo-tools.test.ts do. `HarnessContext` has no
// `decisionsDb` field (only `service`/`prService`/`store`/`resolver`/
// `repoPath`) — open a handle directly via `openDecisionsDb(resolveDecisionsDbPath(h.repoPath))`,
// the idiom already used in tests/mcp-contract/decision-tools.test.ts and
// tests/mcp-contract/todo-tools.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type HarnessContext, callTool } from "./harness.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("MCP provenance filters — decision search", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  // HTTP 400s on `?thread=`; MCP used to silently filter-to-empty, so the same
  // mistake read as "nothing on that thread" on one transport and "malformed
  // input" on the other. `thread` is shared with create/propose (where empty
  // legitimately means absent), so it is guarded per-action, not at the schema.
  it("rejects an empty thread filter on decision search", async () => {
    const res = await callTool(h, "decision", { action: "search", query: "provdec", thread: "" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input/);
  });

  it("rejects an empty thread filter on todo list and search", async () => {
    for (const action of ["list", "search"]) {
      const res = await callTool(h, "todo", { action, query: "x", thread: "" });
      expect(res.isError, action).toBe(true);
      expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input/);
    }
  });

  it("still accepts an empty thread on propose — there it means 'absent'", async () => {
    const res = await callTool(h, "todo", { action: "propose", summary: "empty thread is fine here", thread: "" });
    expect(res.isError).toBeFalsy();
  });

  it("branch: matches the tagged row, excludes a differently-tagged row and a NULL-origin row; absent filter returns all", async () => {
    const mine = await callTool(h, "decision", { action: "create", title: "provdec-mine", description: "d", rationale: "r" });
    const other = await callTool(h, "decision", { action: "create", title: "provdec-other", description: "d", rationale: "r" });
    const untouched = await callTool(h, "decision", { action: "create", title: "provdec-untouched", description: "d", rationale: "r" });
    const mineId = JSON.parse(mine.content[0].text).id as string;
    const otherId = JSON.parse(other.content[0].text).id as string;
    const untouchedId = JSON.parse(untouched.content[0].text).id as string;

    const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
    try {
      // untouchedId is left alone — origin_branch/origin_thread stay NULL,
      // exactly as captureOrigin() stamped them (no git branch in this
      // fixture's zero-commit repo).
      db.prepare("UPDATE decisions SET origin_branch=?, origin_thread=? WHERE id=?")
        .run("feature/mine", "thread-mine", mineId);
      db.prepare("UPDATE decisions SET origin_branch=?, origin_thread=? WHERE id=?")
        .run("feature/other", "thread-other", otherId);

      const byBranch = await callTool(h, "decision", { action: "search", query: "provdec", branch: "feature/mine" });
      expect(byBranch.isError).toBeFalsy();
      const byBranchIds = (JSON.parse(byBranch.content[0].text) as Array<{ id: string }>).map((d) => d.id);
      expect(byBranchIds).toContain(mineId);
      expect(byBranchIds).not.toContain(otherId);
      expect(byBranchIds).not.toContain(untouchedId);

      const byThread = await callTool(h, "decision", { action: "search", query: "provdec", thread: "thread-mine" });
      const byThreadIds = (JSON.parse(byThread.content[0].text) as Array<{ id: string }>).map((d) => d.id);
      expect(byThreadIds).toContain(mineId);
      expect(byThreadIds).not.toContain(otherId);
      expect(byThreadIds).not.toContain(untouchedId);

      const noMatch = await callTool(h, "decision", { action: "search", query: "provdec", branch: "feature/nope" });
      expect(noMatch.content[0].text).toMatch(/No results/i);

      const unfiltered = await callTool(h, "decision", { action: "search", query: "provdec" });
      const unfilteredIds = (JSON.parse(unfiltered.content[0].text) as Array<{ id: string }>).map((d) => d.id);
      expect(unfilteredIds.length).toBeGreaterThan(0);
      expect(unfilteredIds).toEqual(expect.arrayContaining([mineId, otherId, untouchedId]));
    } finally {
      db.close();
    }
  });
});

describe("MCP provenance filters — todo list", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("thread/branch: matches the tagged row, excludes a differently-tagged row and a NULL-origin row; absent filter returns all", async () => {
    const mine = await callTool(h, "todo", { action: "propose", summary: "todofilter-mine" });
    const other = await callTool(h, "todo", { action: "propose", summary: "todofilter-other" });
    const untouched = await callTool(h, "todo", { action: "propose", summary: "todofilter-untouched" });
    const mineId = JSON.parse(mine.content[0].text).id as string;
    const otherId = JSON.parse(other.content[0].text).id as string;
    const untouchedId = JSON.parse(untouched.content[0].text).id as string;

    const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
    try {
      db.prepare("UPDATE todos SET origin_branch=?, origin_thread=? WHERE id=?")
        .run("feature/mine", "t-mine", mineId);
      db.prepare("UPDATE todos SET origin_branch=?, origin_thread=? WHERE id=?")
        .run("feature/other", "t-other", otherId);

      const byThread = await callTool(h, "todo", { action: "list", thread: "t-mine" });
      const byThreadIds = (JSON.parse(byThread.content[0].text) as Array<{ id: string }>).map((t) => t.id);
      expect(byThreadIds).toContain(mineId);
      expect(byThreadIds).not.toContain(otherId);
      expect(byThreadIds).not.toContain(untouchedId);

      const byBranch = await callTool(h, "todo", { action: "list", branch: "feature/mine" });
      const byBranchIds = (JSON.parse(byBranch.content[0].text) as Array<{ id: string }>).map((t) => t.id);
      expect(byBranchIds).toContain(mineId);
      expect(byBranchIds).not.toContain(otherId);
      expect(byBranchIds).not.toContain(untouchedId);

      const miss = await callTool(h, "todo", { action: "list", thread: "t-absent" });
      const missIds = (JSON.parse(miss.content[0].text) as Array<{ id: string }>).map((t) => t.id);
      expect(missIds).not.toContain(mineId);
      expect(missIds).not.toContain(otherId);
      expect(missIds).not.toContain(untouchedId);

      const unfiltered = await callTool(h, "todo", { action: "list" });
      const unfilteredIds = (JSON.parse(unfiltered.content[0].text) as Array<{ id: string }>).map((t) => t.id);
      expect(unfilteredIds.length).toBeGreaterThan(0);
      expect(unfilteredIds).toEqual(expect.arrayContaining([mineId, otherId, untouchedId]));
    } finally {
      db.close();
    }
  });
});

describe("MCP provenance filters — todo search", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("thread/branch: matches the tagged row, excludes a differently-tagged row and a NULL-origin row; absent filter returns all", async () => {
    const mine = await callTool(h, "todo", { action: "propose", summary: "searchfiltertag alpha" });
    const other = await callTool(h, "todo", { action: "propose", summary: "searchfiltertag beta" });
    const untouched = await callTool(h, "todo", { action: "propose", summary: "searchfiltertag gamma" });
    const mineId = JSON.parse(mine.content[0].text).id as string;
    const otherId = JSON.parse(other.content[0].text).id as string;
    const untouchedId = JSON.parse(untouched.content[0].text).id as string;

    const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
    try {
      db.prepare("UPDATE todos SET origin_branch=?, origin_thread=? WHERE id=?")
        .run("feature/mine", "t-mine-2", mineId);
      db.prepare("UPDATE todos SET origin_branch=?, origin_thread=? WHERE id=?")
        .run("feature/other", "t-other-2", otherId);

      const byThread = await callTool(h, "todo", { action: "search", query: "searchfiltertag", thread: "t-mine-2" });
      expect(byThread.isError).toBeFalsy();
      const byThreadIds = (JSON.parse(byThread.content[0].text) as Array<{ id: string }>).map((t) => t.id);
      expect(byThreadIds).toContain(mineId);
      expect(byThreadIds).not.toContain(otherId);
      expect(byThreadIds).not.toContain(untouchedId);

      const byBranch = await callTool(h, "todo", { action: "search", query: "searchfiltertag", branch: "feature/mine" });
      const byBranchIds = (JSON.parse(byBranch.content[0].text) as Array<{ id: string }>).map((t) => t.id);
      expect(byBranchIds).toContain(mineId);
      expect(byBranchIds).not.toContain(otherId);
      expect(byBranchIds).not.toContain(untouchedId);

      const noMatch = await callTool(h, "todo", { action: "search", query: "searchfiltertag", thread: "t-absent" });
      expect(noMatch.content[0].text).toMatch(/No results/i);

      const unfiltered = await callTool(h, "todo", { action: "search", query: "searchfiltertag" });
      const unfilteredIds = (JSON.parse(unfiltered.content[0].text) as Array<{ id: string }>).map((t) => t.id);
      expect(unfilteredIds.length).toBeGreaterThan(0);
      expect(unfilteredIds).toEqual(expect.arrayContaining([mineId, otherId, untouchedId]));
    } finally {
      db.close();
    }
  });
});
