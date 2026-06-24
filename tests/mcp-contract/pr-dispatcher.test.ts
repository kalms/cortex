// tests/mcp-contract/pr-dispatcher.test.ts
//
// Contract coverage for the consolidated `pr` MCP dispatcher (Task 3.3).
//
// The dispatcher is a behavior-preserving facade: each `action` branch calls
// the SAME extracted *Action function the legacy single-purpose tool calls. So
// these tests call `prHandler(...)` directly (bypassing the MCP client) and
// assert each action returns the shape its corresponding legacy contract test
// asserts — proving the switch wires every action to the right handler.
//
// The `touch` action uses `change` (not `action`) as the discriminator.
// The test asserts the response echo does NOT contain `change` or `touch` —
// only pr_number/frame_id/node_name/action — proving the translation is clean.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { prHandler } from "../../src/mcp-server/tools/pr-dispatcher.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { makeIndexedRepoFixture } from "./harness.js";

const BINARY_MISSING = process.env.CORTEX_CONTRACT_BINARY_MISSING === "1";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe.skipIf(BINARY_MISSING)("pr dispatcher contract", () => {
  let repo: string;
  let resolver: RepoContextResolver;
  // The dispatcher closure — built once, matches server.ts wiring
  // (resolver, bus=undefined, indexerProject=CORTEX_CONTRACT_PROJECT).
  let dispatch: (args: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    repo = makeIndexedRepoFixture();
    resolver = new RepoContextResolver({ poolCapacity: 4 });
    const handler = prHandler(resolver, undefined, process.env.CORTEX_CONTRACT_PROJECT);
    dispatch = (args) => handler(args) as Promise<ToolResult>;
  });

  afterAll(() => {
    try { resolver.shutdown(); } catch { /* ignore */ }
    try { rmSync(repo, { recursive: true }); } catch { /* ignore */ }
  });

  it("action:open → action:get round-trip", async () => {
    const openRes = await dispatch({
      repo_path: repo,
      action: "open",
      title: "Dispatcher open",
      author: "rka",
    });
    expect(ResponseSchema.safeParse(openRes).success).toBe(true);
    expect(openRes.isError).toBeFalsy();
    const pr = JSON.parse(openRes.content[0].text);
    expect(typeof pr.number).toBe("number");
    expect(pr.state).toBe("open");

    const getRes = await dispatch({
      repo_path: repo,
      action: "get",
      pr_number: pr.number,
    });
    expect(ResponseSchema.safeParse(getRes).success).toBe(true);
    expect(getRes.isError).toBeFalsy();
    const got = JSON.parse(getRes.content[0].text);
    expect(got.number).toBe(pr.number);
    expect(got.title).toBe("Dispatcher open");
  });

  it("action:touch uses `change` not `action`; response does NOT contain `change` or dispatch action string", async () => {
    // Open a PR first to touch.
    const openRes = await dispatch({
      repo_path: repo,
      action: "open",
      title: "Touch test PR",
      author: "rka",
    });
    const pr = JSON.parse(openRes.content[0].text);

    // Test variant 1: change:"added"
    const touchRes1 = await dispatch({
      repo_path: repo,
      action: "touch",
      pr_number: pr.number,
      frame_id: "src/temporal",
      node_name: "timeline.ts",
      change: "added",
    });
    expect(ResponseSchema.safeParse(touchRes1).success).toBe(true);
    expect(touchRes1.isError).toBeFalsy();

    const text1 = touchRes1.content[0].text;
    // Response must confirm ok:true
    expect(text1).toContain('"ok":true');

    // Response must contain `action` with the translated value (not `change`)
    expect(text1).toContain('"action"');
    expect(text1).toContain('"added"');

    // Raw-text substring guards: must not contain the keyword "change" or dispatch action "touch"
    expect(text1).not.toContain('"change"');
    expect(text1).not.toContain('"touch"');

    // The dispatch discriminator fields must NOT leak into the response echo.
    // The response object must not contain the key "change"
    const parsed1 = JSON.parse(text1);
    expect(Object.keys(parsed1)).not.toContain("change");
    // The dispatch `action` value ("touch") must not appear as a value
    // (the echoed `action` should be "added", not "touch").
    expect(parsed1.action).toBe("added");

    // Test variant 2: change:"modified"
    const touchRes2 = await dispatch({
      repo_path: repo,
      action: "touch",
      pr_number: pr.number,
      frame_id: "src/concurrent",
      node_name: "queue.ts",
      change: "modified",
    });
    expect(ResponseSchema.safeParse(touchRes2).success).toBe(true);
    expect(touchRes2.isError).toBeFalsy();

    const text2 = touchRes2.content[0].text;
    // Response must confirm ok:true
    expect(text2).toContain('"ok":true');

    // Response must contain `action` with the translated value (not `change`)
    expect(text2).toContain('"action"');
    expect(text2).toContain('"modified"');

    // Raw-text substring guards: must not contain the keyword "change" or dispatch action "touch"
    expect(text2).not.toContain('"change"');
    expect(text2).not.toContain('"touch"');

    // The dispatch discriminator fields must NOT leak into the response echo.
    const parsed2 = JSON.parse(text2);
    expect(Object.keys(parsed2)).not.toContain("change");
    // The echoed `action` should be "modified", not "touch".
    expect(parsed2.action).toBe("modified");
  });

  it("action:merge on unknown pr_number returns No results", async () => {
    const res = await dispatch({
      repo_path: repo,
      action: "merge",
      pr_number: 99999,
    });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });

  it("action:get on unknown pr_number returns No results", async () => {
    const res = await dispatch({
      repo_path: repo,
      action: "get",
      pr_number: 99999,
    });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });

  it("missing repo_path → isError with /repo_path required/", async () => {
    // Deliberately omit repo_path — registerTool throws MissingRepoPathError.
    const res = await dispatch({
      action: "open",
      title: "x",
      author: "a",
    }).catch((err: unknown) => {
      // MissingRepoPathError is thrown synchronously by registerTool.
      return { content: [{ type: "text", text: String(err) }], isError: true as const };
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/i);
  });

  it("full lifecycle: open → touch → merge ratifies (no proposed decisions)", async () => {
    const openRes = await dispatch({
      repo_path: repo,
      action: "open",
      title: "Lifecycle PR",
      author: "rka",
    });
    const pr = JSON.parse(openRes.content[0].text);

    const touchRes = await dispatch({
      repo_path: repo,
      action: "touch",
      pr_number: pr.number,
      frame_id: "src/events",
      node_name: "emitter.ts",
      change: "modified",
    });
    expect(touchRes.isError).toBeFalsy();

    const mergeRes = await dispatch({
      repo_path: repo,
      action: "merge",
      pr_number: pr.number,
    });
    expect(ResponseSchema.safeParse(mergeRes).success).toBe(true);
    expect(mergeRes.isError).toBeFalsy();
    // merge returns a merge-result object with ratified_decisions (may be empty
    // when no proposed decisions are linked), not a PR object with state.
    const mergeResult = JSON.parse(mergeRes.content[0].text);
    expect(Array.isArray(mergeResult.ratified_decisions)).toBe(true);

    // get final state via get action
    const getRes = await dispatch({
      repo_path: repo,
      action: "get",
      pr_number: pr.number,
    });
    const got = JSON.parse(getRes.content[0].text);
    expect(got.state).toBe("merged");
  });
});
