// tests/mcp-contract/decision-dispatcher.test.ts
//
// Contract coverage for the consolidated `decision` MCP dispatcher (Task 3.2).
//
// The dispatcher is a behavior-preserving facade: each `action` branch calls
// the SAME extracted *Action function the legacy single-purpose tool calls. So
// these tests call `decisionHandler(...)` directly (bypassing the MCP client)
// and assert each action returns the shape its corresponding legacy contract
// test asserts — proving the switch wires every action to the right handler.
//
// They ALSO assert the freshness-parity invariant: only the `why` action is
// freshness-aware. `get` (and every non-`why` read) must NOT carry a freshness
// note even when the graph is stale. On a `makeIndexedRepoFixture` repo (git
// init, no commit, db copied from the fixture) the indexed_commit recorded in
// the db cannot match HEAD, so freshness is stale — which is exactly when a
// freshness note WOULD appear if a non-`why` action were wrongly made
// freshness-aware.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { decisionHandler } from "../../src/mcp-server/tools/decision-dispatcher.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { makeIndexedRepoFixture } from "./harness.js";

const BINARY_MISSING = process.env.CORTEX_CONTRACT_BINARY_MISSING === "1";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean; freshness?: unknown };

describe.skipIf(BINARY_MISSING)("decision dispatcher contract", () => {
  let repo: string;
  let resolver: RepoContextResolver;
  // The dispatcher closure — built once, matches server.ts wiring
  // (resolver, bus=undefined, indexerProject=CORTEX_CONTRACT_PROJECT).
  let dispatch: (args: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    repo = makeIndexedRepoFixture();
    resolver = new RepoContextResolver({ poolCapacity: 4 });
    const handler = decisionHandler(resolver, undefined, process.env.CORTEX_CONTRACT_PROJECT);
    dispatch = (args) => handler(args) as Promise<ToolResult>;
  });

  afterAll(() => {
    try { resolver.shutdown(); } catch { /* ignore */ }
    try { rmSync(repo, { recursive: true }); } catch { /* ignore */ }
  });

  it("action:create returns JSON with a D- id", async () => {
    const res = await dispatch({
      repo_path: repo,
      action: "create",
      title: "Dispatcher create",
      description: "via dispatcher",
      rationale: "verifying create branch",
      alternatives: [{ name: "alt", reason_rejected: "slower" }],
    });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(parsed.title).toBe("Dispatcher create");
  });

  it("full lifecycle: create → get → update → link → search → delete via the dispatcher", async () => {
    const create = await dispatch({
      repo_path: repo,
      action: "create",
      title: "Lifecycle decision",
      description: "lifecycle",
      rationale: "testing all branches",
    });
    const id = JSON.parse(create.content[0].text).id;
    expect(id).toMatch(/^D-/);

    // get (hit)
    const got = await dispatch({ repo_path: repo, action: "get", id });
    expect(got.isError).toBeFalsy();
    const gotParsed = JSON.parse(got.content[0].text);
    expect(gotParsed.title).toBe("Lifecycle decision");
    // get is NOT freshness-aware — no note even on a stale fixture.
    expect("freshness" in got).toBe(false);

    // update
    const updated = await dispatch({ repo_path: repo, action: "update", id, title: "Lifecycle updated" });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse(updated.content[0].text).title).toBe("Lifecycle updated");

    // link
    const linked = await dispatch({
      repo_path: repo,
      action: "link",
      decision_id: id,
      target: "src/server.ts",
      relation: "GOVERNS",
    });
    expect(linked.isError).toBeFalsy();
    expect(JSON.parse(linked.content[0].text).linked).toBe(true);

    // search (hit)
    const searched = await dispatch({ repo_path: repo, action: "search", query: "Lifecycle updated" });
    expect(searched.isError).toBeFalsy();
    expect(searched.content[0].text).toContain(id);
    // search is NOT freshness-aware.
    expect("freshness" in searched).toBe(false);

    // delete
    const deleted = await dispatch({ repo_path: repo, action: "delete", id });
    expect(deleted.isError).toBeFalsy();
    expect(deleted.content[0].text).toContain(id);

    // get after delete → empty envelope
    const afterDelete = await dispatch({ repo_path: repo, action: "get", id });
    expect(ResponseSchema.safeParse(afterDelete).success).toBe(true);
    expect(afterDelete.content[0].text).toMatch(/^No results: /);
  });

  it("action:get on a missing id returns the empty envelope", async () => {
    const res = await dispatch({ repo_path: repo, action: "get", id: "D-nope" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text).toMatch(/^No results: get_decision\(D-nope\)/);
  });

  it("action:search with no matches returns the empty envelope", async () => {
    const res = await dispatch({ repo_path: repo, action: "search", query: "zzzNoSuchDecision999" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text).toMatch(/^No results: /);
  });

  it("action:propose creates a proposed decision", async () => {
    const res = await dispatch({
      repo_path: repo,
      action: "propose",
      title: "Proposed via dispatcher",
      problem: "what to do",
      resolution: "do this",
      rationale: "because",
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.id).toMatch(/^D-/);
    expect(parsed.status).toBe("proposed");
    await dispatch({ repo_path: repo, action: "delete", id: parsed.id });
  });

  it("action:supersede atomically replaces an existing decision", async () => {
    const orig = await dispatch({
      repo_path: repo,
      action: "create",
      title: "Original for supersede",
      description: "d",
      rationale: "r",
    });
    const oldId = JSON.parse(orig.content[0].text).id;

    const res = await dispatch({
      repo_path: repo,
      action: "supersede",
      old_decision_id: oldId,
      title: "Superseding decision",
      problem: "old was wrong",
      resolution: "new approach",
      rationale: "better",
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.id).toMatch(/^D-/);
    expect(parsed.id).not.toBe(oldId);

    // Old decision must now be superseded.
    const oldGot = await dispatch({ repo_path: repo, action: "get", id: oldId });
    expect(oldGot.isError).toBeFalsy();
    expect(JSON.parse(oldGot.content[0].text).status).toBe("superseded");
  });

  it("action:supersede on a missing id returns empty", async () => {
    const res = await dispatch({
      repo_path: repo,
      action: "supersede",
      old_decision_id: "D-zzzz",
      title: "x",
      problem: "p",
      resolution: "r",
      rationale: "ra",
    });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text).toMatch(/^No results: supersede_decision\(D-zzzz\)/);
  });

  it("action:promote promotes an existing decision to a tier", async () => {
    const create = await dispatch({
      repo_path: repo,
      action: "create",
      title: "Promote via dispatcher",
      description: "d",
      rationale: "r",
    });
    const id = JSON.parse(create.content[0].text).id;

    const res = await dispatch({ repo_path: repo, action: "promote", id, tier: "team" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.tier).toBe("team");
    await dispatch({ repo_path: repo, action: "delete", id });
  });

  it("action:candidates returns a read-only manifest", async () => {
    const res = await dispatch({ repo_path: repo, action: "candidates", max_candidates: 5 });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();
    // Manifest is a JSON array of candidate objects (bare array, not wrapped).
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("action:reconcile on a decision with no GOVERNS links returns not_reconcilable", async () => {
    const create = await dispatch({
      repo_path: repo,
      action: "create",
      title: "Reconcile target",
      description: "d",
      rationale: "r",
    });
    const id = JSON.parse(create.content[0].text).id;

    const res = await dispatch({ repo_path: repo, action: "reconcile", decision_id: id, verdict: "match" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    // No GOVERNS links → declarative → not_reconcilable error.
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^ERROR reason=not_reconcilable: /);
    await dispatch({ repo_path: repo, action: "delete", id });
  });

  it("action:reconcile on a missing decision returns empty", async () => {
    const res = await dispatch({ repo_path: repo, action: "reconcile", decision_id: "D-zzzz", verdict: "match" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text).toMatch(/^No results: /);
  });

  it("action:pending returns a pending list shape", async () => {
    const res = await dispatch({ repo_path: repo, action: "pending", limit: 10 });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed.pending)).toBe(true);
  });

  it("action:why returns empty for an unknown symbol", async () => {
    const res = await dispatch({ repo_path: repo, action: "why", qualified_name: "no.such.symbol.anywhere" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text).toMatch(/^No results: why_was_this_built\(/);
  });

  describe("freshness parity: only `why` is freshness-aware", () => {
    it("`why` carries freshness and `get` does not, even when the graph is stale", async () => {
      // Seed a decision so `get` returns a hit (ok envelope, the case where a
      // wrongly-applied freshness note would surface).
      const create = await dispatch({
        repo_path: repo,
        action: "create",
        title: "Freshness parity decision",
        description: "d",
        rationale: "r",
      });
      const id = JSON.parse(create.content[0].text).id;

      // Enable freshness for the duration of these assertions. The fixture repo
      // has no commit recorded in the indexed DB, so the verdict is always
      // non-fresh — which means `why` MUST attach a freshness field.
      const priorFreshness = process.env.CORTEX_FRESHNESS;
      process.env.CORTEX_FRESHNESS = "1";
      let why: ToolResult;
      let got: ToolResult;
      try {
        why = await dispatch({ repo_path: repo, action: "why", qualified_name: "no.such.symbol" });
        got = await dispatch({ repo_path: repo, action: "get", id });
      } finally {
        if (priorFreshness === undefined) {
          delete process.env.CORTEX_FRESHNESS;
        } else {
          process.env.CORTEX_FRESHNESS = priorFreshness;
        }
      }

      // Both succeed (no thrown error; valid envelope).
      expect(ResponseSchema.safeParse(why).success).toBe(true);
      expect(got.isError).toBeFalsy();

      // `get` is NEVER freshness-aware — no freshness field, no note text.
      expect("freshness" in got).toBe(false);
      expect(got.content[0].text).not.toContain("cortex freshness:");

      // `why` IS freshness-aware — the fixture is stale, so the note must appear.
      expect("freshness" in why).toBe(true);

      await dispatch({ repo_path: repo, action: "delete", id });
    });
  });
});
