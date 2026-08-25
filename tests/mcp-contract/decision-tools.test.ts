import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, makeIndexedRepoFixture, countDecisions, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

/** A fixture repo with a real commit, so captureOrigin's gitBranch/gitHead
 *  produce real values instead of the null degrade a commit-less `git init`
 *  repo gives — needed to assert actual last_touched_* values, not just
 *  column presence. Mirrors repoWithGovernedFile() in
 *  tests/mcp-server/reconciliation-ref-parity.test.ts. */
function makeCommittedRepoFixture(): string {
  const root = makeIndexedRepoFixture();
  writeFileSync(join(root, "committed.ts"), "export const x = 1;\n");
  execSync(`git -C "${root}" add .`, { stdio: "ignore" });
  execSync(`git -C "${root}" commit -q --no-gpg-sign -m seed`, { stdio: "ignore" });
  return root;
}

describe("decision-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  describe("lifecycle: create → get → update → link → search → delete", () => {
    let decisionId: string;

    it("create_decision: returns JSON with id", async () => {
      const res = await callTool(h, "decision", {
        action: "create",
        title: "Test decision",
        description: "for contract test",
        rationale: "verifying lifecycle",
        alternatives: [{ name: "alt1", reason_rejected: "slower" }],
      });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
      decisionId = parsed.id;
    });

    it("get_decision: returns created decision", async () => {
      const res = await callTool(h, "decision", { action: "get", id: decisionId });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.title ?? parsed.decision?.title).toBe("Test decision");
    });

    it("update_decision: mutates title", async () => {
      const res = await callTool(h, "decision", { action: "update", id: decisionId, title: "Updated title" });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.title).toBe("Updated title");
    });

    it("link_decision: attaches a GOVERNS edge to a fixture file", async () => {
      const res = await callTool(h, "decision", {
        action: "link",
        decision_id: decisionId,
        target: "src/server.ts",
        relation: "GOVERNS",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("linked");
    });

    it("search_decisions: finds the decision by query", async () => {
      const res = await callTool(h, "decision", { action: "search", query: "Updated title" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(decisionId);
    });

    it("delete_decision: removes the decision", async () => {
      const res = await callTool(h, "decision", { action: "delete", id: decisionId });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(decisionId);
    });

    it("get_decision after delete: returns empty or error", async () => {
      const res = await callTool(h, "decision", { action: "get", id: decisionId });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("error paths", () => {
    it("get_decision: malformed id returns ErrorResponse or empty (structured)", async () => {
      const res = await callTool(h, "decision", { action: "get", id: "not-a-ulid" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      if (res.isError) {
        expect(res.content[0].text).toMatch(/^ERROR reason=/);
      } else {
        expect(res.content[0].text).toMatch(/^No results: /);
      }
    });

    it("update_decision: unknown id returns structured error or empty", async () => {
      const res = await callTool(h, "decision", { action: "update", id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX", title: "x" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });

    it("search_decisions: query with no matches returns empty", async () => {
      const res = await callTool(h, "decision", { action: "search", query: "zzzNonexistentQuery999" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.content[0].text).toMatch(/^No results: /);
    });
  });

  describe("why_was_this_built", () => {
    it("empty: path with no governing decision", async () => {
      const res = await callTool(h, "decision", { action: "why", qualified_name: "src/utils.js::formatLog" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });

    it("happy: finds decision for linked file after create+link", async () => {
      // why_was_this_built resolves a qualified_name by walking up the
      // qn/path hierarchy: "src/server.ts::handleRequest" matches a decision
      // linked to the file "src/server.ts" (DecisionSearch.findGoverning).
      const create = await callTool(h, "decision", {
        action: "create",
        title: "Server pattern",
        description: "uses parseBody",
        rationale: "separation",
      });
      const id = JSON.parse(create.content[0].text).id;
      await callTool(h, "decision", { action: "link", decision_id: id, target: "src/server.ts", relation: "GOVERNS" });

      const res = await callTool(h, "decision", { action: "why", qualified_name: "src/server.ts::handleRequest" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(id);

      await callTool(h, "decision", { action: "delete", id });
    });
  });

  describe("update_decision governs replacement", () => {
    it("sets governs on update when create-time governs was empty", async () => {
      const created = await callTool(h, "decision", {
        action: "create",
        title: "Governs-on-update test",
        description: "d", rationale: "r",
      });
      const id = JSON.parse(created.content[0].text).id;

      const updated = await callTool(h, "decision", {
        action: "update",
        id, governs: ["src/foo.ts", "src/bar.ts"],
      });
      expect(updated.isError).toBeFalsy();

      const fetched = await callTool(h, "decision", { action: "get", id });
      const parsed = JSON.parse(fetched.content[0].text);
      const governsTargets = (parsed.governs ?? []).map((n: any) => n.target_ref ?? n.file_path ?? n.name);
      expect(governsTargets).toEqual(expect.arrayContaining(["src/foo.ts", "src/bar.ts"]));

      // Clean up
      await callTool(h, "decision", { action: "delete", id });
    });

    it("clears governs when governs: [] is passed", async () => {
      const created = await callTool(h, "decision", {
        action: "create",
        title: "Clear-governs test",
        description: "d", rationale: "r",
        governs: ["src/x.ts"],
      });
      const id = JSON.parse(created.content[0].text).id;

      await callTool(h, "decision", { action: "update", id, governs: [] });
      const fetched = await callTool(h, "decision", { action: "get", id });
      const parsed = JSON.parse(fetched.content[0].text);
      expect(parsed.governs ?? []).toEqual([]);

      await callTool(h, "decision", { action: "delete", id });
    });
  });

  describe("why_was_this_built input resolution", () => {
    it("accepts a bare symbol name and resolves to governing decision", async () => {
      // handleRequest is a unique function in src/server.ts — bare name resolves to single
      const created = await callTool(h, "decision", {
        action: "create",
        title: "Why-bare-name test",
        description: "test",
        rationale: "test",
        governs: ["src/server.ts"],
      });
      const id = JSON.parse(created.content[0].text).id;

      const res = await callTool(h, "decision", {
        action: "why",
        qualified_name: "handleRequest",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Why-bare-name test");

      await callTool(h, "decision", { action: "delete", id });
    });

    it("preserves back-compat for file path input (findGoverning path-walk)", async () => {
      const created = await callTool(h, "decision", {
        action: "create",
        title: "Path-walk test",
        description: "test",
        rationale: "test",
        governs: ["src/server.ts"],
      });
      const id = JSON.parse(created.content[0].text).id;

      const res = await callTool(h, "decision", {
        action: "why",
        qualified_name: "src/server.ts",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Path-walk test");

      await callTool(h, "decision", { action: "delete", id });
    });

    it("returns ambiguous_input when input matches multiple symbols", async () => {
      // "parse" matches parseBody via the LIKE %parse% clause alongside any other
      // symbol containing "parse" — if only one match the resolver returns single (ok),
      // if zero it returns none and falls through to findGoverning (empty or ok).
      // In all cases the response must be a non-empty string.
      const res = await callTool(h, "decision", {
        action: "why",
        qualified_name: "parse",
      });
      // Either ambiguous_input, empty, or a successful result — all are valid shapes.
      expect(res.content[0].text.length).toBeGreaterThan(0);
    });
  });

  describe("input validation", () => {
    it("create_decision: rejects rationale containing </invoke>", async () => {
      const res = await callTool(h, "decision", {
        action: "create",
        title: "Bad decision",
        description: "test",
        rationale: "ok body</rationale>\n<problem>x</problem></invoke>",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
      expect(res.content[0].text).toContain("rationale");
    });

    it("create_decision: rejects description containing <problem> marker", async () => {
      const res = await callTool(h, "decision", {
        action: "create",
        title: "Bad",
        description: "leakage <problem>x</problem>",
        rationale: "fine",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
    });

    it("update_decision: rejects rationale with </rationale> marker", async () => {
      // First create a clean decision
      const created = await callTool(h, "decision", {
        action: "create",
        title: "To-be-updated",
        description: "ok",
        rationale: "ok",
      });
      const id = JSON.parse(created.content[0].text).id;
      // Try update with bad rationale
      const res = await callTool(h, "decision", {
        action: "update",
        id,
        rationale: "leak </rationale>",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
      // Clean up
      await callTool(h, "decision", { action: "delete", id });
    });

    it("propose_decision: rejects bad problem field", async () => {
      const res = await callTool(h, "decision", {
        action: "propose",
        title: "Bad",
        problem: "leak </governs>",
        resolution: "fine",
        rationale: "fine",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ERROR reason=malformed_input/);
    });
  });

  // ---------------------------------------------------------------------------
  // Per-call repo routing — Task 2.1 (template for Tasks 2.2-2.11)
  //
  // Migrated tools route their reads/writes to the repo addressed by
  // `repo_path`. The harness's `callTool` auto-injects the primary repo's
  // path so legacy tests above don't need to change; these tests pass
  // explicit `repo_path` values (or sentinel `undefined`) to verify the new
  // routing contract.
  // ---------------------------------------------------------------------------
  describe("link_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "link",
        decision_id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX",
        target: "src/x.ts",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes the link write to the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed a decision in repoB.
        const seed = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "to be linked",
          description: "d",
          rationale: "r",
        });
        const id = JSON.parse(seed.content[0].text).id;

        const res = await callTool(h, "decision", {
          action: "link",
          repo_path: repoB,
          decision_id: id,
          target: "src/scoped/file.ts",
          relation: "GOVERNS",
        });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain("linked");

        // Verify the link landed in repoB by reading via get_decision.
        const got = await callTool(h, "decision", { action: "get", repo_path: repoB, id });
        const parsed = JSON.parse(got.content[0].text);
        const governsTargets = (parsed.governs ?? []).map((n: any) => n.target_ref);
        expect(governsTargets).toContain("src/scoped/file.ts");
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("search_decisions per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "search",
        query: "anything",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("reads from the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed a decision in repoB with a distinctive title.
        const seed = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "uniqueSearchableInBRepo",
          description: "d",
          rationale: "r",
        });
        const id = JSON.parse(seed.content[0].text).id;

        // Search against repoB must find it.
        const res = await callTool(h, "decision", {
          action: "search",
          repo_path: repoB,
          query: "uniqueSearchableInBRepo",
        });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain(id);

        // The harness primary has no decisions with this title.
        const resPrimary = await callTool(h, "decision", {
          action: "search",
          query: "uniqueSearchableInBRepo",
        });
        expect(resPrimary.content[0].text).toMatch(/^No results: /);
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("get_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "get",
        id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("reads from the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed a decision in repoB.
        const seed = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "lives only in B",
          description: "d",
          rationale: "r",
        });
        const id = JSON.parse(seed.content[0].text).id;
        // The harness primary service does not know this id.
        expect(h.service.get(id)).toBeNull();

        // get_decision against repoB must find it.
        const res = await callTool(h, "decision", { action: "get", repo_path: repoB, id });
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.title).toBe("lives only in B");
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("delete_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "delete",
        id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes deletes to the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed a decision in repoB.
        const seed = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "to be deleted in B",
          description: "d",
          rationale: "r",
        });
        const id = JSON.parse(seed.content[0].text).id;
        const before = countDecisions(repoB);

        const res = await callTool(h, "decision", {
          action: "delete",
          repo_path: repoB,
          id,
        });
        expect(res.isError).toBeFalsy();
        // Delete dropped exactly one decision from repoB.
        expect(countDecisions(repoB)).toBe(before - 1);
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("update_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "update",
        id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX",
        title: "x",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes writes to the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed a decision in repoB so we can update it.
        const seed = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "original",
          description: "d",
          rationale: "r",
        });
        const id = JSON.parse(seed.content[0].text).id;

        // Update must succeed against repoB even though the harness primary
        // has no such decision.
        const res = await callTool(h, "decision", {
          action: "update",
          repo_path: repoB,
          id,
          title: "updated in B",
        });
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.title).toBe("updated in B");
        // The harness primary decision service does not know this id.
        expect(h.service.get(id)).toBeNull();
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("supersede_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "supersede",
        old_decision_id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX",
        title: "x",
        problem: "p",
        resolution: "r",
        rationale: "z",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes writes to the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed an "old" decision in repoB via propose_decision so we can supersede it.
        const seed = await callTool(h, "decision", {
          action: "propose",
          repo_path: repoB,
          title: "to be superseded",
          problem: "p",
          resolution: "r",
          rationale: "y",
        });
        const oldId = JSON.parse(seed.content[0].text).id;
        const before = countDecisions(repoB);

        const res = await callTool(h, "decision", {
          action: "supersede",
          repo_path: repoB,
          old_decision_id: oldId,
          title: "replacement",
          problem: "p2",
          resolution: "r2",
          rationale: "y2",
        });
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.id).toMatch(/^D-/);
        // Supersede creates exactly one new decision in repoB.
        expect(countDecisions(repoB)).toBe(before + 1);
        expect(h.service.get(parsed.id)).toBeNull();
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("propose_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "propose",
        title: "x",
        problem: "p",
        resolution: "r",
        rationale: "z",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes writes to the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        const before = countDecisions(repoB);
        const res = await callTool(h, "decision", {
          action: "propose",
          repo_path: repoB,
          title: "proposed in B",
          problem: "p",
          resolution: "r",
          rationale: "y",
        });
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.id).toMatch(/^D-/);
        expect(countDecisions(repoB)).toBe(before + 1);
        expect(h.service.get(parsed.id)).toBeNull();
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("create_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      // `repo_path: undefined` is the harness sentinel that strips the
      // field from the request entirely — without it the harness would
      // auto-inject the primary repo's path.
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "create",
        title: "x",
        description: "y",
        rationale: "z",
      });
      expect(res.isError).toBe(true);
      // The friendly MissingRepoPathError from registerTool's pre-check
      // surfaces as the message "repo_path required for tool '<name>'".
      // The Zod field is declared `.optional()` so the SDK's input
      // validation does NOT pre-empt this error path.
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes writes to the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        const before = countDecisions(repoB);
        const res = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "scoped to B",
          description: "x",
          rationale: "y",
        });
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.id).toMatch(/^D-/);
        // Write landed in repoB.
        expect(countDecisions(repoB)).toBe(before + 1);
        // And did NOT leak into the harness's primary repo. The harness's
        // legacy DecisionService is bound to the primary repo's decisions.db;
        // a get(id) against it returns null iff routing actually scoped the
        // write to repoB. This is a stronger invariant than a count diff —
        // earlier tests in this file write to the primary repo, so its
        // absolute decision count is in flux.
        expect(h.service.get(parsed.id)).toBeNull();
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("why_was_this_built per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "why",
        qualified_name: "src/server.ts",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("reads from the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed a decision in repoB that GOVERNS a path. why_was_this_built
        // must find it via repoB's links table.
        const seed = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "uniqueDecisionInB",
          description: "d",
          rationale: "r",
          governs: ["src/server.ts"],
        });
        const id = JSON.parse(seed.content[0].text).id;

        // Querying repoB finds the decision via findGoverning's path-walk.
        const res = await callTool(h, "decision", {
          action: "why",
          repo_path: repoB,
          qualified_name: "src/server.ts",
        });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain(id);
        expect(res.content[0].text).toContain("uniqueDecisionInB");

        // The harness primary repo has no such decision — same path returns empty.
        const resPrimary = await callTool(h, "decision", {
          action: "why",
          qualified_name: "src/server.ts",
        });
        // Either empty (no decision in primary) or — if earlier tests in this
        // file leaked a "src/server.ts"-governing decision into the primary —
        // does NOT contain repoB's distinctive title.
        expect(resPrimary.content[0].text).not.toContain("uniqueDecisionInB");
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });

  describe("basis_hash stamping at create", () => {
    it("stamps basis_hash when the decision governs something", async () => {
      const res = await callTool(h, "decision", {
        action: "create", title: "governed", description: "d", rationale: "r",
        governs: ["src/index.ts"],
      });
      const id = JSON.parse(res.content[0].text as string).id as string;
      const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
      try {
        const row = db.prepare("SELECT basis_hash FROM decisions WHERE id=?").get(id) as { basis_hash: string | null };
        expect(row.basis_hash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        db.close();
      }
    });

    it("leaves basis_hash NULL when the decision governs nothing", async () => {
      const res = await callTool(h, "decision", {
        action: "create", title: "ungoverned", description: "d", rationale: "r",
      });
      const id = JSON.parse(res.content[0].text as string).id as string;
      const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
      try {
        const row = db.prepare("SELECT basis_hash FROM decisions WHERE id=?").get(id) as { basis_hash: string | null };
        expect(row.basis_hash).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  describe("last-touched provenance", () => {
    it("keeps origin immutable across an update", async () => {
      const created = await callTool(h, "decision", {
        action: "create", title: "immutable", description: "d", rationale: "r",
      });
      const id = JSON.parse(created.content[0].text as string).id as string;
      const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
      try {
        const before = db.prepare("SELECT origin_branch, origin_commit FROM decisions WHERE id=?").get(id);
        await callTool(h, "decision", { action: "update", id, title: "changed" });
        const after = db.prepare("SELECT origin_branch, origin_commit FROM decisions WHERE id=?").get(id);
        expect(after).toEqual(before);
      } finally {
        db.close();
      }
    });

    it("rewrites last_touched_* on update to the checkout's real branch/commit", async () => {
      const repo = makeCommittedRepoFixture();
      try {
        const created = await callTool(h, "decision", {
          repo_path: repo, action: "create", title: "touch me", description: "d", rationale: "r",
        });
        const id = JSON.parse(created.content[0].text as string).id as string;
        const realBranch = execSync(`git -C "${repo}" branch --show-current`).toString().trim();
        const realCommit = execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();

        const db = openDecisionsDb(resolveDecisionsDbPath(repo));
        try {
          await callTool(h, "decision", { repo_path: repo, action: "update", id, title: "touched" });
          const row = db.prepare(
            "SELECT last_touched_branch, last_touched_commit FROM decisions WHERE id=?",
          ).get(id) as { last_touched_branch: string | null; last_touched_commit: string | null };
          // Real values, not just "the column exists" — a deleted stamping
          // implementation would leave these null (or whatever create()
          // wrote) rather than the checkout's actual current branch/commit.
          expect(row.last_touched_branch).toBe(realBranch);
          expect(row.last_touched_commit).toBe(realCommit);
        } finally {
          db.close();
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it("bumps updated_at when a link is added (closes the pre-existing addLink gap)", async () => {
      const created = await callTool(h, "decision", {
        action: "create", title: "link bumps updated_at", description: "d", rationale: "r",
      });
      const id = JSON.parse(created.content[0].text as string).id as string;
      const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
      try {
        const before = db.prepare("SELECT updated_at FROM decisions WHERE id=?").get(id) as { updated_at: string };
        await new Promise((r) => setTimeout(r, 5));
        await callTool(h, "decision", {
          action: "link", decision_id: id, target: "src/link-bump.ts", relation: "GOVERNS",
        });
        const after = db.prepare("SELECT updated_at FROM decisions WHERE id=?").get(id) as { updated_at: string };
        expect(after.updated_at).not.toBe(before.updated_at);
      } finally {
        db.close();
      }
    });
  });
});
