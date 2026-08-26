// tests/api/provenance-wire-path.test.ts
//
// END-TO-END proof that a REAL git identity travels the whole read path:
//
//   real git checkout → create → SQLite row → repository read → adapter → Zod
//
// A test that only asserts "the field exists and is nullable" survives BOTH
// silent failure modes this feature has: (a) the wire schema gaining the field
// while the adapter never populates it, and (b) the adapter populating it from
// a record whose repository SELECT never projected the column — in which case
// `undefined ?? null` reads null forever and every nullability assertion still
// passes. So every assertion below pins the SAME concrete branch string that
// the checkout actually has.
import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";
import { StoriesRepository } from "../../src/stories/repository.js";
import { StoryService } from "../../src/stories/service.js";
import { captureOrigin } from "../../src/git/origin.js";
import { buildAdaptedDecision } from "../../src/mcp-server/api-decisions.js";
import { buildAdaptedTodo } from "../../src/mcp-server/api-todos.js";
import { buildAdaptedStory } from "../../src/mcp-server/api-stories.js";
import {
  AdaptedDecisionSchema,
  AdaptedTodoSchema,
  AdaptedStorySchema,
} from "../../src/mcp-server/api-schemas.js";

const BRANCH = "feature/wire-proof";
const cleanup: string[] = [];
afterAll(() => { while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

/** A real git checkout sitting on a known, non-default branch name. */
function gitRepoOnBranch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-wire-")));
  cleanup.push(root);
  execSync(`git init -q "${root}"`);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  execSync(`git -C "${root}" add .`);
  execSync(`git -C "${root}" commit -q --no-gpg-sign -m seed`);
  execSync(`git -C "${root}" checkout -q -b ${BRANCH}`);
  return root;
}

function setup() {
  const root = gitRepoOnBranch();
  const db = openDecisionsDb(join(root, "decisions.db"));
  const origin = captureOrigin(root, "thread-e2e");
  // Guard the guard: if the checkout itself has no branch the rest of this
  // test would be asserting null === null.
  expect(origin.branch).toBe(BRANCH);
  expect(origin.commit).toMatch(/^[0-9a-f]{40}$/);
  return { root, db, origin };
}

describe("provenance travels DB → repository → adapter → wire", () => {
  it("a decision created on a real branch reports that branch on the wire", () => {
    const { db, origin } = setup();
    const decisions = new DecisionsRepository(db);
    const links = new DecisionLinksRepository(db);
    const created = new DecisionService({ db, decisions, links })
      .create({ title: "t", rationale: "r", origin });

    // 1. the raw row really carries it
    const raw = db.prepare(
      "SELECT origin_branch, origin_commit, origin_thread, last_touched_branch FROM decisions WHERE id = ?",
    ).get(created.id) as Record<string, unknown>;
    expect(raw.origin_branch).toBe(BRANCH);
    expect(raw.origin_thread).toBe("thread-e2e");

    // 2. the REPOSITORY read surfaces it (this is the column-projection gap)
    const rec = decisions.get(created.id)!;
    expect(rec.origin_branch).toBe(BRANCH);
    expect(rec.origin_commit).toBe(origin.commit);
    expect(rec.origin_thread).toBe("thread-e2e");
    expect(rec.last_touched_branch).toBe(BRANCH);

    // 2b. list() is a SEPARATE read site with its own column-projection gap —
    // get() being fixed proves nothing about list().
    const fromList = decisions.list().find((d) => d.id === created.id)!;
    expect(fromList.origin_branch).toBe(BRANCH);
    expect(fromList.origin_commit).toBe(origin.commit);

    // 3. the ADAPTER carries it, and 4. the wire schema parses it through
    const wire = AdaptedDecisionSchema.parse(buildAdaptedDecision(rec, [], new Map(), new Map()));
    expect(wire.originBranch).toBe(BRANCH);
    expect(wire.originCommit).toBe(origin.commit);
    expect(wire.originThread).toBe("thread-e2e");
    expect(wire.lastTouchedBranch).toBe(BRANCH);
    expect(wire.lastTouchedCommit).toBe(origin.commit);
    // Ungoverned create stamps no basis, and nothing has been reconciled yet.
    expect(wire.basisHash).toBeNull();
    expect(wire.reconciledBranch).toBeNull();
    expect(wire.reconciledCommit).toBeNull();
  });

  it("a governed decision reports its basis hash and reconciliation checkout on the wire", () => {
    const { db, origin } = setup();
    const decisions = new DecisionsRepository(db);
    const links = new DecisionLinksRepository(db);
    const created = new DecisionService({ db, decisions, links })
      .create({ title: "t", rationale: "r", governs: ["a.ts"], origin });

    // basis_hash and reconciled_* are written by paths outside this task; write
    // them directly so the READ path is what is under test here.
    decisions.update(created.id, { basis_hash: "b".repeat(64) });
    decisions.recordReconciliation(created.id, {
      reconciliation_verdict: "match",
      reconciled_at: new Date().toISOString(),
      reconciled_source_hash: "b".repeat(64),
      reconciled_by: "claude",
      nonconformant_nodes: null,
      reconciliation_note: null,
      reconciled_branch: BRANCH,
      reconciled_commit: origin.commit,
    });

    const rec = decisions.get(created.id)!;
    expect(rec.basis_hash).toBe("b".repeat(64));
    expect(rec.reconciled_branch).toBe(BRANCH);

    const wire = AdaptedDecisionSchema.parse(buildAdaptedDecision(rec, [], new Map(), new Map()));
    expect(wire.basisHash).toBe("b".repeat(64));
    expect(wire.reconciledBranch).toBe(BRANCH);
    expect(wire.reconciledCommit).toBe(origin.commit);
  });

  it("a todo created on a real branch reports that branch on the wire", () => {
    const { db, origin } = setup();
    const todos = new TodosRepository(db);
    const links = new TodoLinksRepository(db);
    const created = new TodoService({ db, todos, links })
      .propose({ summary: "s", origin });

    const raw = db.prepare("SELECT origin_branch FROM todos WHERE id = ?")
      .get(created.id) as Record<string, unknown>;
    expect(raw.origin_branch).toBe(BRANCH);

    todos.update(created.id, { basis_hash: "c".repeat(64) });

    const rec = todos.get(created.id)!;
    expect(rec.origin_branch).toBe(BRANCH);
    expect(rec.origin_thread).toBe("thread-e2e");
    expect(rec.basis_hash).toBe("c".repeat(64));

    // list() is a separate read site with its own column-projection gap.
    const fromList = todos.list().find((t) => t.id === created.id)!;
    expect(fromList.origin_branch).toBe(BRANCH);
    expect(fromList.basis_hash).toBe("c".repeat(64));

    const wire = AdaptedTodoSchema.parse(buildAdaptedTodo(rec, [], [], new Map(), new Map()));
    expect(wire.originBranch).toBe(BRANCH);
    expect(wire.originCommit).toBe(origin.commit);
    expect(wire.originThread).toBe("thread-e2e");
    expect(wire.lastTouchedBranch).toBe(BRANCH);
    expect(wire.lastTouchedCommit).toBe(origin.commit);
    expect(wire.basisHash).toBe("c".repeat(64));
  });

  it("a story created on a real branch reports that branch on the wire", () => {
    const { db, origin } = setup();
    const stories = new StoriesRepository(db);
    const created = new StoryService({ db })
      .create({ title: "t", steps: [{ caption: "one", refs: [] }], origin });

    const raw = db.prepare("SELECT origin_branch FROM stories WHERE id = ?")
      .get(created.id) as Record<string, unknown>;
    expect(raw.origin_branch).toBe(BRANCH);

    const rec = stories.get(created.id)!;
    expect(rec.origin_branch).toBe(BRANCH);
    expect(rec.origin_thread).toBe("thread-e2e");

    // list() is a separate read site with its own column-projection gap.
    const fromList = stories.list().find((s) => s.id === created.id)!;
    expect(fromList.origin_branch).toBe(BRANCH);
    expect(fromList.origin_thread).toBe("thread-e2e");

    const wire = AdaptedStorySchema.parse(buildAdaptedStory(rec, 1));
    expect(wire.originBranch).toBe(BRANCH);
    expect(wire.originCommit).toBe(origin.commit);
    expect(wire.originThread).toBe("thread-e2e");
    expect(wire.lastTouchedBranch).toBe(BRANCH);
    expect(wire.lastTouchedCommit).toBe(origin.commit);
  });
});
