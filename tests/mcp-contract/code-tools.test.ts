import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, makeIndexedRepoFixture, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { rmSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/db/registry.js";

describe("code-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  describe("search_graph", () => {
    it("happy: name_pattern matches fixture function", async () => {
      const res = await callTool(h, "search_graph", { name_pattern: "handleRequest" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).toContain("src/server.ts::handleRequest");
    });

    it("empty: unknown name returns No results", async () => {
      const res = await callTool(h, "search_graph", { name_pattern: "zzzNonexistent" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("empty: a symbol miss routes the caller to search_code, not to reindexing", async () => {
      // Regression guard for T-ghza: a bare "No results" read as "the index is
      // stale" and sent two agents off to re-run index_repository. The miss must
      // name the tool that would actually answer, and disclaim staleness.
      const res = await callTool(h, "search_graph", { name_pattern: "zzzNonexistent" });
      expect(res.content[0].text).toContain("search_code(");
      expect(res.content[0].text).toMatch(/freshness/i);
    });

    it("an enumeration miss (kinds/label only) does not route to search_code", async () => {
      // No name or qn to re-search as text, so search_code has no pattern to
      // take and cannot answer "what Interfaces exist" — same reason the hint
      // stays off trace_path's no-edges case.
      const res = await callTool(h, "search_graph", { label: "zzzNoSuchLabel" });
      expect(res.content[0].text).toMatch(/^No results: /);
      expect(res.content[0].text).not.toContain("search_code(");
    });

    it("a qn_pattern miss is targeted, so it does route to search_code", async () => {
      const res = await callTool(h, "search_graph", { qn_pattern: "src/server.ts::zzzNope" });
      expect(res.content[0].text).toMatch(/^No results: /);
      expect(res.content[0].text).toContain("search_code(");
    });

    it("happy: colon-form qn_pattern normalizes correctly", async () => {
      const res = await callTool(h, "search_graph", { qn_pattern: "src/server.ts::handleRequest" });
      expect(res.content[0].text).toContain("src/server.ts::handleRequest");
    });

    it("happy: label filter", async () => {
      const res = await callTool(h, "search_graph", { label: "Class" });
      expect(res.content[0].text).toContain("Router");
    });

    it("default filter reports suppressed sections in the header", async () => {
      // "Overview" is a markdown section in the fixture (docs/guide.md), not code.
      const res = await callTool(h, "search_graph", { name_pattern: "Overview" });
      expect(res.content[0].text).toContain("section nodes suppressed");
    });

    it("explicit kinds filter does not report suppressed sections", async () => {
      // The caller scoped to functions; sections weren't hidden by a default,
      // so the suppression note must not appear.
      const res = await callTool(h, "search_graph", { name_pattern: "Overview", kinds: ["function"] });
      expect(res.content[0].text).not.toContain("suppressed");
    });
  });

  describe("get_code_snippet", () => {
    it("happy: colon form returns snippet", async () => {
      const res = await callTool(h, "get_code_snippet", { qualified_name: "src/server.ts::handleRequest" });
      expect(res.content[0].text).toContain("export function handleRequest");
    });

    it("round-trip: search_graph output feeds get_code_snippet", async () => {
      const search = await callTool(h, "search_graph", { name_pattern: "handleRequest" });
      // search_graph output now leads with a "showing …" header line; the qn
      // appears on the ranked result rows below it, so match the full text.
      const qnMatch = search.content[0].text.match(/(\S+\.ts::\S+)/);
      expect(qnMatch).not.toBeNull();
      const res = await callTool(h, "get_code_snippet", { qualified_name: qnMatch![1] });
      expect(res.content[0].text).toContain("export function handleRequest");
    });

    it("empty: unknown symbol", async () => {
      const res = await callTool(h, "get_code_snippet", { qualified_name: "src/server.ts::zzz" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("empty: unknown symbol routes to search_code", async () => {
      const res = await callTool(h, "get_code_snippet", { qualified_name: "src/server.ts::zzz" });
      expect(res.content[0].text).toContain("search_code(");
    });
  });

  describe("trace_path", () => {
    it("happy: calls mode returns reachable nodes with depth annotation", async () => {
      const res = await callTool(h, "trace_path", { function_name: "handleRequest", mode: "calls" });
      expect(res.content[0].text).toMatch(/\[d=\d+\]/);
      expect(res.content[0].text).toContain("parseBody");
    });

    it("happy: max_depth limits results", async () => {
      const res = await callTool(h, "trace_path", { function_name: "handleRequest", mode: "calls", max_depth: 1 });
      const text = res.content[0].text;
      const depths = Array.from(text.matchAll(/\[d=(\d+)\]/g)).map((m) => parseInt(m[1], 10));
      expect(Math.max(...depths)).toBeLessThanOrEqual(1);
    });

    it("empty: unknown function", async () => {
      const res = await callTool(h, "trace_path", { function_name: "zzzNonexistent", mode: "calls" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("empty: an unresolvable function name routes to search_code", async () => {
      const res = await callTool(h, "trace_path", { function_name: "zzzNonexistent", mode: "calls" });
      expect(res.content[0].text).toContain("search_code(");
    });

    it("a resolved symbol with no edges does not route to search_code", async () => {
      // The symbol WAS found; "the graph carries no node for this shape" is the
      // wrong diagnosis, and search_code cannot answer "who calls this" anyway.
      // parseBody is a leaf in the fixture, so calls-mode returns nothing.
      const res = await callTool(h, "trace_path", { function_name: "parseBody", mode: "calls" });
      expect(res.content[0].text).toMatch(/^No results: /);
      expect(res.content[0].text).not.toContain("search_code(");
    });
  });

  describe("get_graph_schema", () => {
    it("happy: returns labels and counts", async () => {
      const res = await callTool(h, "get_graph_schema", {});
      expect(res.content[0].text).toMatch(/function: \d+/);
      expect(res.content[0].text).toMatch(/Edge types:/);
    });
  });

  describe("search_code", () => {
    // Now that search_code anchors to ctx.repoPath (Field Report rec #5) the
    // grep no longer roots itself in the server process's cwd — so the "empty
    // path not found" case is finally testable: just point search_code at a
    // repo whose source tree doesn't contain the pattern.
    it("happy: pattern found with enclosing function", async () => {
      // The harness primary repo has only a .cortex/db (no source files), so
      // construct a tmp repo with a source file the pattern can match.
      const tmpRepo = mkdtempSync(join(tmpdir(), "cortex-search-happy-"));
      try {
        execSync(`git init -q "${tmpRepo}"`);
        mkdirSync(join(tmpRepo, ".cortex"));
        copyFileSync(join(h.repoPath, ".cortex", "db"), join(tmpRepo, ".cortex", "db"));
        mkdirSync(join(tmpRepo, "src"));
        writeFileSync(
          join(tmpRepo, "src", "server.ts"),
          "export function handleRequest() { return 'ok'; }\n",
        );

        const res = await callTool(h, "search_code", {
          repo_path: tmpRepo,
          pattern: "handleRequest",
        });
        expect(ResponseSchema.safeParse(res).success).toBe(true);
        expect(res.content[0].text).toContain("handleRequest");
      } finally {
        try { rmSync(tmpRepo, { recursive: true }); } catch { /* ignore */ }
      }
    }, 15_000);
  });

  describe("get_code_snippet input resolution", () => {
    it("accepts a raw file path — returns snippet or ambiguous_input with candidates", async () => {
      const res = await callTool(h, "get_code_snippet", {
        qualified_name: "src/server.ts",
      });
      // A file path matching multiple symbols → ambiguous_input listing candidates
      // A file path matching exactly one symbol → snippet
      if (res.isError) {
        expect(res.content[0].text).toMatch(/ERROR reason=ambiguous_input/);
        // Candidates must reference the file
        expect(res.content[0].text).toContain("src/server.ts");
      } else {
        expect(res.content[0].text).toContain("handleRequest");
      }
    });

    it("returns ambiguous_input or single result for bare name", async () => {
      const res = await callTool(h, "get_code_snippet", {
        qualified_name: "handleRequest",
      });
      if (res.isError) {
        expect(res.content[0].text).toMatch(/ERROR reason=ambiguous_input/);
      } else {
        expect(res.content[0].text.length).toBeGreaterThan(0);
      }
    });

    it("returns empty for zero matches", async () => {
      const res = await callTool(h, "get_code_snippet", {
        qualified_name: "totallymadeup_function_xyzzy",
      });
      expect(res.content[0].text).toMatch(/^No results: /);
    });
  });

  describe("trace_path input resolution", () => {
    it("accepts a raw file path — returns ambiguous_input with candidates", async () => {
      // src/server.ts has 2 functions (parseBody + handleRequest), so the
      // resolver should return ambiguous_input rather than silently returning
      // empty results.
      const res = await callTool(h, "trace_path", {
        function_name: "src/server.ts",
        mode: "callers",
      });
      // After wiring the resolver, a file path matching multiple symbols must
      // produce ambiguous_input — NOT silently return "No results".
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=ambiguous_input/);
      expect(res.content[0].text).toContain("src/server.ts");
    });

    it("accepts a bare name (single match → resolves and returns callers)", async () => {
      // parseBody is unique in the fixture and is called by handleRequest.
      // After wiring the resolver, callers mode should find handleRequest.
      const res = await callTool(h, "trace_path", {
        function_name: "parseBody",
        mode: "callers",
      });
      // Either success (with [d=N] lines) or ambiguous_input on multi-match
      if (res.isError) {
        expect(res.content[0].text).toMatch(/ERROR reason=ambiguous_input/);
      } else {
        // Should resolve and find callers (handleRequest calls parseBody)
        expect(res.content[0].text).toMatch(/\[d=\d+\]/);
      }
    });
  });

  describe("delete_project", () => {
    it("validates structured response (success or structured error)", async () => {
      // Use an obviously-nonexistent project name to avoid mutating real state.
      const res = await callTool(h, "delete_project", { project: "zzzNonexistentProjectForTesting_9f3a" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      // Must not be bare prose — either success (unlikely for nonexistent) or structured ErrorResponse.
      if (res.isError) {
        expect(res.content[0].text).toMatch(/^ERROR reason=/);
      }
    });
  });

  describe("list_projects", () => {
    it("happy: includes the fixture project once the resolver has touched it", async () => {
      // list_projects now reads from `RepoContextResolver.listKnownRepos`.
      // The harness's primary repo isn't in the master cache directory
      // (it lives at `<harnessDir>/repo/.cortex/db`); it only becomes visible
      // after the resolver pools it via a tool call. Pool it via any
      // per-repo tool, then assert list_projects surfaces it.
      await callTool(h, "search_graph", { name_pattern: "_does_not_exist_" });
      const res = await callTool(h, "list_projects", {});
      expect(res.content[0].text).toContain(h.repoPath);
    });

    it("Field Report rec #1: returns every indexed repo the resolver can address", async () => {
      // Contract guarantee: when an agent has indexed N repos, list_projects
      // must return all N — not just the one the server was started in.
      // The 2026-05-26 field report described a state where list_projects
      // returned only the local-DB project and hid the other 9 cache repos.
      const second = makeIndexedRepoFixture();
      try {
        // Pool both repos via per-repo tool calls.
        await callTool(h, "search_graph", { name_pattern: "_does_not_exist_" });
        await callTool(h, "search_graph", { repo_path: second, name_pattern: "_does_not_exist_" });
        const res = await callTool(h, "list_projects", {});
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain(h.repoPath);
        expect(res.content[0].text).toContain(second);
      } finally {
        try { rmSync(second, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("delete_project", () => {
    it("removes a project from the master registry; list_projects no longer surfaces it", async () => {
      // list_projects now enumerates from the master Registry
      // (~/.cache/cortex-indexer/_registry.db). Seed two phantom registry
      // entries (non-tmp paths so they aren't rejected), confirm list_projects
      // surfaces them, then delete one and assert it drops from the list while
      // the other remains. delete_project removes the registry row.
      const stamp = Date.now();
      const slugA = `cortex-test-delete-a-${stamp}`;
      const slugB = `cortex-test-delete-b-${stamp}`;
      const reg = new Registry();
      try {
        reg.register(slugA, `/phantom/${slugA}`);
        reg.register(slugB, `/phantom/${slugB}`);
      } finally {
        reg.close();
      }
      try {
        // Sanity: both visible before delete.
        const before = await callTool(h, "list_projects", {});
        expect(before.content[0].text).toContain(slugA);
        expect(before.content[0].text).toContain(slugB);

        // Delete A via the migrated crossRepo tool (removes the registry row;
        // the underlying indexer delete is a no-op for a phantom path).
        await callTool(h, "delete_project", { project: slugA });

        // Direct check: delete_project removed slugA from the registry, kept slugB.
        const check = new Registry();
        try {
          const names = check.list().map((r) => r.name);
          expect(names).not.toContain(slugA);
          expect(names).toContain(slugB);
        } finally {
          check.close();
        }

        // list_projects no longer mentions A, but still mentions B.
        const after = await callTool(h, "list_projects", {});
        expect(after.content[0].text).not.toContain(slugA);
        expect(after.content[0].text).toContain(slugB);
      } finally {
        const cleanup = new Registry();
        try { cleanup.remove(slugA); cleanup.remove(slugB); } finally { cleanup.close(); }
      }
    });
  });

  describe("index_status", () => {
    it("happy: returns indexed status for the harness repo", async () => {
      // After migration, index_status reads .cortex/db at repo_path.
      // The harness sets up its own indexed git root; query it directly.
      const res = await callTool(h, "index_status", { repo_path: h.repoPath });
      expect(res.content[0].text).toMatch(/^Indexed: /);
    });

    it("empty: unknown path returns No results", async () => {
      // index_status is allowUnindexed — so a non-existent path doesn't
      // throw RepoNotIndexedError, it returns the empty envelope.
      const res = await callTool(h, "index_status", { repo_path: "/nonexistent/path" });
      expect(res.content[0].text).toMatch(/^No results: /);
    });

    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "index_status", { repo_path: undefined });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });
  });

  describe("detect_changes", () => {
    it("happy: returns structured response for the harness repo (success or error)", async () => {
      // After migration to per-call routing, detect_changes runs against
      // ctx.repoPath (auto-injected by the harness). The harness's tmp git
      // root has no committed source files, so the indexer may report
      // success with no changes or a structured error. Either is valid.
      const res = await callTool(h, "detect_changes", {});
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("index_repository", () => {
    it("happy: re-indexes harness repo without erroring", async () => {
      // After migration, index_repository takes repo_path. The harness
      // primary repo is a real git root with .cortex/db already populated,
      // so this should hit the cache path or run the indexer cleanly.
      const res = await callTool(h, "index_repository", { repo_path: h.repoPath });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).not.toMatch(/^ERROR /);
    });

    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "index_repository", { repo_path: undefined });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("indexes a fresh git root that has no prior .cortex/db", async () => {
      // The point of allowUnindexed: a repo that doesn't have an index YET
      // is exactly the input index_repository is meant to handle.
      const fresh = mkdtempSync(join(tmpdir(), "cortex-fresh-"));
      try {
        execSync(`git init -q "${fresh}"`);
        // No .cortex/db yet — default-mode routing would throw RepoNotIndexed.
        const res = await callTool(h, "index_repository", { repo_path: fresh });
        expect(ResponseSchema.safeParse(res).success).toBe(true);
        // The indexer subprocess may report an error (empty repo, no files)
        // but it must NOT be a routing error — i.e. we must have made it
        // past the resolver.
        expect(res.content[0].text).not.toMatch(/repo_path required/);
      } finally {
        try { rmSync(fresh, { recursive: true }); } catch { /* ignore */ }
      }
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Per-call repo routing — Phase 3 Group A (search_graph, get_code_snippet,
  // trace_path, detect_changes, get_graph_schema).
  //
  // These tests pass explicit `repo_path` values (or sentinel `undefined`) to
  // verify the new routing contract. Legacy tests above continue to work via
  // the harness's auto-injected primary repo.
  // ---------------------------------------------------------------------------

  describe("search_graph per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "search_graph", {
        repo_path: undefined,
        name_pattern: "handleRequest",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes the query to the addressed repo, not the server's cwd", async () => {
      // repoB has its own .cortex/db (copy of the same fixture). The query
      // must resolve project + nodes through repoB's DB, not the harness primary.
      const repoB = makeIndexedRepoFixture();
      try {
        const res = await callTool(h, "search_graph", {
          repo_path: repoB,
          name_pattern: "handleRequest",
        });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain("src/server.ts::handleRequest");
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("get_code_snippet per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "get_code_snippet", {
        repo_path: undefined,
        qualified_name: "src/server.ts::handleRequest",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes the lookup to the addressed repo, not the server's cwd", async () => {
      // repoB shares its ctx_projects.root_path with the harness primary (both
      // point at the same on-disk fixture). The point of the test is to assert
      // the query plumbing runs through repoB's DB — verified by getting a
      // non-error snippet for a symbol resolved out of that DB.
      const repoB = makeIndexedRepoFixture();
      try {
        const res = await callTool(h, "get_code_snippet", {
          repo_path: repoB,
          qualified_name: "src/server.ts::handleRequest",
        });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain("export function handleRequest");
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("trace_path per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "trace_path", {
        repo_path: undefined,
        function_name: "handleRequest",
        mode: "calls",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes the trace to the addressed repo, not the server's cwd", async () => {
      // Asserts both that the start-node lookup AND the CALLS-edge walk run
      // through repoB's DB — handleRequest calls parseBody in the fixture, so
      // a successful trace surfaces parseBody.
      const repoB = makeIndexedRepoFixture();
      try {
        const res = await callTool(h, "trace_path", {
          repo_path: repoB,
          function_name: "handleRequest",
          mode: "calls",
        });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toMatch(/\[d=\d+\]/);
        expect(res.content[0].text).toContain("parseBody");
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("detect_changes per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "detect_changes", {
        repo_path: undefined,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes the diff against the addressed repo, not the server's cwd", async () => {
      // The indexer reads git history at ctx.repoPath. Verify the call goes
      // through (structured response, not a path-not-found error) when an
      // explicit repo_path is passed.
      const repoB = makeIndexedRepoFixture();
      try {
        const res = await callTool(h, "detect_changes", { repo_path: repoB });
        expect(ResponseSchema.safeParse(res).success).toBe(true);
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("get_graph_schema per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "get_graph_schema", {
        repo_path: undefined,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("reads schema from the addressed repo, not the server's cwd", async () => {
      // repoB has the same fixture data; assert the schema response is non-empty
      // and shaped right, which confirms the read went through repoB's DB.
      const repoB = makeIndexedRepoFixture();
      try {
        const res = await callTool(h, "get_graph_schema", { repo_path: repoB });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toMatch(/function: \d+/);
        expect(res.content[0].text).toMatch(/Edge types:/);
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("search_code per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "search_code", {
        repo_path: undefined,
        pattern: "handleRequest",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    }, 15_000);

    it("routes the grep target to the addressed repo (Field Report rec #5)", async () => {
      // Field Report observed search_code grepping the server's process.cwd()
      // when project resolution fell through. After migration the rg/grep
      // subprocess is anchored to ctx.repoPath. We verify this by running
      // search_code against a tmp git root whose ONLY file is a sentinel:
      // if the routing is broken, the cwd-defaulted grep would find some
      // unrelated occurrence (or zero occurrences for a uniquely-named
      // sentinel) instead of the file we just created.
      const sentinel = "ZZZ_SEARCH_CODE_ROUTING_SENTINEL_a7f9";
      const tmpRepo = mkdtempSync(join(tmpdir(), "cortex-search-code-"));
      try {
        execSync(`git init -q "${tmpRepo}"`);
        mkdirSync(join(tmpRepo, ".cortex"));
        // Copy the harness's primary cortex.db so the resolver accepts the path.
        copyFileSync(join(h.repoPath, ".cortex", "db"), join(tmpRepo, ".cortex", "db"));
        writeFileSync(join(tmpRepo, "sentinel.txt"), `// ${sentinel}\n`);

        const res = await callTool(h, "search_code", {
          repo_path: tmpRepo,
          pattern: sentinel,
        });
        expect(res.isError).toBeFalsy();
        // The sentinel only exists in tmpRepo. If we got a hit, the grep
        // ran with cwd=tmpRepo as it should.
        expect(res.content[0].text).toContain(sentinel);
        expect(res.content[0].text).toContain("sentinel.txt");
      } finally {
        try { rmSync(tmpRepo, { recursive: true }); } catch { /* ignore */ }
      }
    }, 15_000);
  });
});
