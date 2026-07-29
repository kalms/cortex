/**
 * MCP contract test for `changes_since` (P8 temporal layer, lean v1).
 *
 * The harness repo has a populated `.cortex/db` (fixture graph with
 * src/server.ts symbols) but no commits — this suite lays down its own
 * history: commit 1 (tagged v0) → commit 2 touching src/server.ts, plus a
 * sidecar decision governing src/server.ts, then asserts the window join:
 * commits + affected graph nodes + decisions created/governing in window.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

describe("changes_since contract", () => {
  let h: HarnessContext;
  let decisionId: string;

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", h.repoPath, ...args], { encoding: "utf-8" }).trim();
  }

  beforeAll(async () => {
    h = await createHarness();
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    // Commit 1 — pre-window baseline, tagged v0. Backdated so window
    // boundaries are deterministic (git --since has 1 s granularity and the
    // whole fixture otherwise lands inside a single second).
    writeFileSync(join(h.repoPath, "README.md"), "# fixture\n");
    git("add", "README.md");
    execFileSync(
      "git", ["-C", h.repoPath, "commit", "--no-gpg-sign", "-m", "chore: baseline"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        },
      },
    );
    git("tag", "v0");

    // Commit 2 — inside the window, touches the graph-known file.
    mkdirSync(join(h.repoPath, "src"), { recursive: true });
    writeFileSync(join(h.repoPath, "src", "server.ts"), "export function handleRequest() {}\n");
    git("add", "src/server.ts");
    git("commit", "--no-gpg-sign", "-m", "feat(server): change handler");

    // A decision governing the changed file, created inside the window.
    const created = await callTool(h, "decision", {
      action: "create",
      title: "Handler stays synchronous",
      description: "handleRequest remains a sync function.",
      rationale: "Simplicity over throughput here.",
      governs: ["src/server.ts"],
    });
    expect(created.isError).toBeFalsy();
    decisionId = JSON.parse(created.content[0].text).id;
  });

  afterAll(async () => { await h.close(); });

  it("since=<tag>: returns only the in-window commit and joins the decision layer", async () => {
    const res = await callTool(h, "changes_since", { since: "v0" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();

    const payload = JSON.parse(res.content[0].text.split("\n\n⚠")[0]);
    expect(payload.since.kind).toBe("ref");
    expect(payload.commits.length).toBe(1);
    expect(payload.commits[0].subject).toBe("feat(server): change handler");
    expect(payload.changed_files).toEqual(["src/server.ts"]);
    expect(payload.truncated).toBe(false);

    // Graph join: the fixture graph knows src/server.ts symbols. (Stored
    // qualified_name is the indexer's dotted form with a run-specific
    // project slug — match on file_path + name instead.)
    const hit = payload.affected_nodes.find(
      (n: { name: string; file_path: string }) =>
        n.file_path === "src/server.ts" && n.name === "handleRequest");
    expect(hit).toBeDefined();

    // Decision layer: created in window AND governing the changed file.
    const createdIds = payload.decisions.created.map((d: { id: string }) => d.id);
    expect(createdIds).toContain(decisionId);
    const governing = payload.decisions.governing_changed.find(
      (d: { id: string }) => d.id === decisionId);
    expect(governing).toBeDefined();
    expect(governing.matched_files).toEqual(["src/server.ts"]);
  });

  it("since=<decision id>: the decision's capture time opens the window", async () => {
    const res = await callTool(h, "changes_since", { since: decisionId });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text.split("\n\n⚠")[0]);
    expect(payload.since.kind).toBe("decision");
    // The pre-window baseline commit is excluded. (The feat commit lands in
    // the same wall-clock second as the decision — git's --since granularity
    // is 1 s, so its inclusion is a boundary coin-flip we don't assert.)
    const subjects = payload.commits.map((c: { subject: string }) => c.subject);
    expect(subjects).not.toContain("chore: baseline");
    expect(payload.decisions.created.map((d: { id: string }) => d.id)).toContain(decisionId);
  });

  it("scope filters commits down to the prefix", async () => {
    const res = await callTool(h, "changes_since", { since: "v0", scope: "docs/" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text.split("\n\n⚠")[0]);
    expect(payload.commits.length).toBe(0);
    expect(payload.changed_files).toEqual([]);
  });

  it("garbage since is malformed_input", async () => {
    const res = await callTool(h, "changes_since", { since: "definitely-not-a-thing" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input: unresolvable since/);
  });

  it("missing repo_path is rejected with the routing error", async () => {
    const raw = await h.client.callTool({ name: "changes_since", arguments: { since: "v0" } });
    const res = raw as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });
});
