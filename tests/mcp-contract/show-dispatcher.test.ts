// tests/mcp-contract/show-dispatcher.test.ts
//
// Contract coverage for the consolidated `show` MCP dispatcher (Task 9):
// story/advance/get/list/close/delete verbs backed by StoryService, plus
// T-7e5b hardening on the unknown-action default arm. The `focus` verb (2a)
// is exercised here too to prove its texts are byte-identical after the
// dispatcher rewrite; its capture-server-backed delivery coverage lives in
// show-tools.test.ts (via the full MCP client) — this file calls
// `showHandler` directly, mirroring decision-dispatcher.test.ts's idiom.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { showHandler, showAction } from "../../src/mcp-server/tools/show-dispatcher.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { makeIndexedRepoFixture } from "./harness.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

/** A fixture repo with a real commit, so captureOrigin's gitBranch/gitHead
 *  produce real values instead of the null degrade the shared `repo` fixture
 *  (a commit-less `git init`) gives — needed to assert actual
 *  last_touched_* values, not just column presence. Mirrors
 *  repoWithGovernedFile() in tests/mcp-server/reconciliation-ref-parity.test.ts. */
function makeCommittedRepoFixture(): string {
  const root = makeIndexedRepoFixture();
  writeFileSync(join(root, "committed.ts"), "export const x = 1;\n");
  execSync(`git -C "${root}" add .`, { stdio: "ignore" });
  execSync(`git -C "${root}" commit -q --no-gpg-sign -m seed`, { stdio: "ignore" });
  return root;
}

const BINARY_MISSING = process.env.CORTEX_CONTRACT_BINARY_MISSING === "1";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe.skipIf(BINARY_MISSING)("show dispatcher contract", () => {
  let repo: string;
  let resolver: RepoContextResolver;
  // The dispatcher closure — built once, matches server.ts wiring.
  let dispatch: (args: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(() => {
    repo = makeIndexedRepoFixture();
    resolver = new RepoContextResolver({ poolCapacity: 4 });
    const handler = showHandler(resolver);
    dispatch = (args) => handler(args) as Promise<ToolResult>;
  });

  afterAll(() => {
    try { resolver.shutdown(); } catch { /* ignore */ }
    try { rmSync(repo, { recursive: true }); } catch { /* ignore */ }
  });

  describe("focus (2a) unchanged via the dispatcher", () => {
    let server: ReturnType<typeof createServer>;
    let port: number;
    let requests: Array<{ path: string; body: unknown }>;
    let prevPort: string | undefined;

    beforeAll(async () => {
      requests = [];
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ version: 1, accepted: true }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as AddressInfo).port;
      prevPort = process.env.CORTEX_VIEWER_PORT;
      process.env.CORTEX_VIEWER_PORT = String(port);
    });

    afterAll(async () => {
      if (prevPort === undefined) delete process.env.CORTEX_VIEWER_PORT;
      else process.env.CORTEX_VIEWER_PORT = prevPort;
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    });

    it("delivers the focus body and reports Spotlight set", async () => {
      const res = await dispatch({ repo_path: repo, action: "focus", refs: ["src/a.ts::fn"], note: "look here" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Spotlight set (1 refs) — clear with refs: []");
      expect(requests[requests.length - 1].path).toBe("/api/show-focus");
      expect(requests[requests.length - 1].body).toMatchObject({ refs: ["src/a.ts::fn"], note: "look here" });
    });

    it("omitting refs posts refs: [] and reports Spotlight cleared", async () => {
      const res = await dispatch({ repo_path: repo, action: "focus" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("Spotlight cleared");
      expect(requests[requests.length - 1].body).toMatchObject({ refs: [] });
    });
  });

  describe("story lifecycle via the dispatcher", () => {
    // discoverViewerPort/postToViewer both call global fetch; mocking it to
    // always fail keeps `story`/`advance` deterministic regardless of a real
    // dev server on the machine's conventional 3333/3334 viewer ports (see
    // tests/mcp-server/viewer-post.test.ts for the same idiom).
    const origFetch = global.fetch;
    beforeAll(() => {
      global.fetch = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
    });
    afterAll(() => {
      global.fetch = origFetch;
      vi.restoreAllMocks();
    });

    it("action:story creates a walkthrough, returning an S- id and a viewer_url with ?story=", async () => {
      const res = await dispatch({
        repo_path: repo,
        action: "story",
        title: "Lifecycle story",
        steps: [
          { caption: "first", refs: ["src/a.ts"] },
          { caption: "second", refs: ["src/b.ts"] },
        ],
      });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.story_id).toMatch(/^S-/);
      expect(parsed.step_count).toBe(2);
      expect(parsed.status).toBe("open");
      expect(parsed.viewer_url).toContain(`?story=${parsed.story_id}`);
    });

    it("action:story requires title and steps", async () => {
      const noTitle = await dispatch({ repo_path: repo, action: "story", steps: [{ caption: "x", refs: [] }] });
      expect(noTitle.isError).toBe(true);
      expect(noTitle.content[0].text).toMatch(/^ERROR reason=malformed_input: /);

      const noSteps = await dispatch({ repo_path: repo, action: "story", title: "No steps" });
      expect(noSteps.isError).toBe(true);
      expect(noSteps.content[0].text).toMatch(/^ERROR reason=malformed_input: /);
    });

    it("action:advance against an unreachable viewer returns 'No viewer reachable', not an error", async () => {
      const create = await dispatch({
        repo_path: repo,
        action: "story",
        title: "Advance target",
        steps: [{ caption: "only step", refs: [] }],
      });
      const id = JSON.parse(create.content[0].text).story_id;

      const res = await dispatch({ repo_path: repo, action: "advance", story_id: id, step: 1 });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("No viewer reachable — story persists; open it via its viewer_url");
    });

    it("action:advance with a step out of range returns malformed_input", async () => {
      const create = await dispatch({
        repo_path: repo,
        action: "story",
        title: "Range target",
        steps: [{ caption: "only step", refs: [] }],
      });
      const id = JSON.parse(create.content[0].text).story_id;

      const res = await dispatch({ repo_path: repo, action: "advance", story_id: id, step: 9 });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input: /);
      expect(res.content[0].text).toMatch(/out of range/);
    });

    it("action:advance on a closed story returns malformed_input", async () => {
      const create = await dispatch({
        repo_path: repo,
        action: "story",
        title: "Closed target",
        closed: true,
        steps: [{ caption: "only step", refs: [] }],
      });
      const id = JSON.parse(create.content[0].text).story_id;
      expect(JSON.parse(create.content[0].text).status).toBe("closed");

      const res = await dispatch({ repo_path: repo, action: "advance", story_id: id, step: 1 });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input: /);
      expect(res.content[0].text).toMatch(/closed/);
    });

    it("get/list/close/delete round-trip", async () => {
      const create = await dispatch({
        repo_path: repo,
        action: "story",
        title: "Round trip",
        steps: [{ caption: "step", refs: ["x"] }],
      });
      const id = JSON.parse(create.content[0].text).story_id;

      // get (hit)
      const got = await dispatch({ repo_path: repo, action: "get", story_id: id });
      expect(got.isError).toBeFalsy();
      const gotParsed = JSON.parse(got.content[0].text);
      expect(gotParsed.title).toBe("Round trip");
      expect(gotParsed.steps).toHaveLength(1);

      // list (contains it)
      const list = await dispatch({ repo_path: repo, action: "list" });
      expect(list.isError).toBeFalsy();
      const listParsed = JSON.parse(list.content[0].text);
      expect(Array.isArray(listParsed)).toBe(true);
      expect(listParsed.some((s: { id: string }) => s.id === id)).toBe(true);

      // close
      const closed = await dispatch({ repo_path: repo, action: "close", story_id: id });
      expect(closed.isError).toBeFalsy();
      expect(JSON.parse(closed.content[0].text).status).toBe("closed");

      // delete
      const deleted = await dispatch({ repo_path: repo, action: "delete", story_id: id });
      expect(deleted.isError).toBeFalsy();
      expect(deleted.content[0].text).toBe(`Deleted ${id}`);

      // get after delete → empty envelope
      const afterDelete = await dispatch({ repo_path: repo, action: "get", story_id: id });
      expect(ResponseSchema.safeParse(afterDelete).success).toBe(true);
      expect(afterDelete.content[0].text).toMatch(/^No results: /);
    });

    it("close keeps origin immutable and rewrites last_touched_* to the checkout's real branch/commit", async () => {
      const committedRepo = makeCommittedRepoFixture();
      try {
        const create = await dispatch({
          repo_path: committedRepo,
          action: "story",
          title: "Close stamps last-touched",
          steps: [{ caption: "step", refs: [] }],
        });
        const id = JSON.parse(create.content[0].text).story_id;
        const realBranch = execSync(`git -C "${committedRepo}" branch --show-current`).toString().trim();
        const realCommit = execSync(`git -C "${committedRepo}" rev-parse HEAD`).toString().trim();

        const db = openDecisionsDb(resolveDecisionsDbPath(committedRepo));
        try {
          const before = db.prepare(
            "SELECT origin_branch, origin_commit FROM stories WHERE id=?",
          ).get(id);

          const closed = await dispatch({ repo_path: committedRepo, action: "close", story_id: id });
          expect(closed.isError).toBeFalsy();

          const after = db.prepare(
            "SELECT origin_branch, origin_commit, last_touched_branch, last_touched_commit FROM stories WHERE id=?",
          ).get(id) as Record<string, unknown>;
          // Origin is immutable across the close.
          expect({ origin_branch: after.origin_branch, origin_commit: after.origin_commit }).toEqual(before);
          // Real values, not just "the column exists" — a deleted stamping
          // implementation would leave these at whatever create() wrote
          // (or null) rather than the checkout's actual current branch/commit.
          expect(after.last_touched_branch).toBe(realBranch);
          expect(after.last_touched_commit).toBe(realCommit);
        } finally {
          db.close();
        }
      } finally {
        rmSync(committedRepo, { recursive: true, force: true });
      }
    });

    it("action:get on a missing story returns the empty envelope", async () => {
      const res = await dispatch({ repo_path: repo, action: "get", story_id: "S-zzzz" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("action:delete on a missing story returns the empty envelope", async () => {
      const res = await dispatch({ repo_path: repo, action: "delete", story_id: "S-zzzz" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("action:close on a missing story returns the empty envelope (not-found, not malformed)", async () => {
      const res = await dispatch({ repo_path: repo, action: "close", story_id: "S-zzzz" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("action:list returns the empty envelope when a repo has zero stories", async () => {
      const emptyRepo = makeIndexedRepoFixture();
      try {
        const res = await dispatch({ repo_path: emptyRepo, action: "list" });
        expect(ResponseSchema.safeParse(res).success).toBe(true);
        expect(res.content[0].text).toBe("No results: show(list)");
      } finally {
        rmSync(emptyRepo, { recursive: true });
      }
    });
  });

  describe("action:advance delivers the resolved canonical id to a real viewer", () => {
    // Mirrors the focus describe block's capture-server pattern above — a
    // real ephemeral HTTP server, not a mocked fetch, so the captured POST
    // body actually pins what gets sent over the wire. Uses its own fresh
    // repo (not the shared `repo`) so this story's `seq` is deterministically
    // 1, independent of how many stories other tests in this file created.
    let server: ReturnType<typeof createServer>;
    let port: number;
    let requests: Array<{ path: string; body: unknown }>;
    let prevPort: string | undefined;
    let seqRepo: string;

    beforeAll(async () => {
      seqRepo = makeIndexedRepoFixture();
      requests = [];
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ version: 1, accepted: true }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as AddressInfo).port;
      prevPort = process.env.CORTEX_VIEWER_PORT;
      process.env.CORTEX_VIEWER_PORT = String(port);
    });

    afterAll(async () => {
      if (prevPort === undefined) delete process.env.CORTEX_VIEWER_PORT;
      else process.env.CORTEX_VIEWER_PORT = prevPort;
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      try { rmSync(seqRepo, { recursive: true }); } catch { /* ignore */ }
    });

    it("posts the canonical S- id, not the raw seq-form input, to /api/show-advance", async () => {
      const create = await dispatch({
        repo_path: seqRepo,
        action: "story",
        title: "Seq-form advance",
        steps: [{ caption: "only step", refs: [] }],
      });
      const canonicalId = JSON.parse(create.content[0].text).story_id;
      expect(canonicalId).toMatch(/^S-/);

      // First story minted in a fresh repo → seq 1. "1" is the seq-form
      // reference (parseRef treats an all-digit body as a seq lookup).
      const res = await dispatch({ repo_path: seqRepo, action: "advance", story_id: "1", step: 1 });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe(`Story ${canonicalId} → step 1/1 pushed to viewer`);

      const advanceReq = requests.find((r) => r.path === "/api/show-advance");
      expect(advanceReq).toBeDefined();
      const body = advanceReq!.body as { story_id: string; step: number };
      expect(body.story_id).toBe(canonicalId);
      expect(body.story_id).not.toBe("1");
      expect(body.step).toBe(1);
    });
  });

  describe("action:<unknown> default arm (T-7e5b)", () => {
    it("returns malformed_input when action is not one of the seven known verbs", async () => {
      const ctx = resolver.resolve(repo);
      // Casts an invalid action past TypeScript's compile-time enum check —
      // showAction (unlike showHandler) skips Zod validation, so this is the
      // only way to actually exercise the default arm, which is otherwise
      // unreachable through the validated `action` enum (same as every other
      // consolidated dispatcher; see decision-dispatcher.ts).
      const res = await showAction(ctx, { action: "bogus" as never, repo_path: repo });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^ERROR reason=malformed_input: /);
      expect(res.content[0].text).toContain("Unknown show action: bogus");
    });
  });
});
