import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDecisionsDb } from "../../../src/decisions/db.js";
import { DecisionsRepository, type DecisionRecord } from "../../../src/decisions/repository.js";
import { DecisionLinksRepository, type Relation } from "../../../src/decisions/links-repository.js";

// Direct path to tsx — mirrors the pattern in tests/cli/decision-candidates.test.ts.
const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

function decisionsDbPath(repo: string): string {
  return join(repo, ".cortex", "decisions.db");
}

/**
 * Build a minimally "indexed" repo fixture: a git root with an empty
 * `.cortex/decisions.db` already created. Mirrors what `cortex decision rehome`
 * checks for on the target side (presence of the sidecar DB) and on the source
 * side (presence of the cwd's git root).
 */
function makeIndexedRepoFixture(prefix = "cortex-rehome-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  // Eagerly create the decisions.db so the dir looks "indexed" to the rehome
  // verb. `openDecisionsDb` creates parent dirs and applies the schema.
  const db = openDecisionsDb(decisionsDbPath(root));
  db.close();
  return root;
}

type CreateOpts = { id?: string };

function createDecisionInRepo(
  repo: string,
  fields: { title: string; description: string; rationale: string },
  opts: CreateOpts = {},
): string {
  const db = openDecisionsDb(decisionsDbPath(repo));
  try {
    const repo_d = new DecisionsRepository(db);
    const id = opts.id ?? randomUUID();
    const now = new Date().toISOString();
    const rec: DecisionRecord = {
      id,
      title: fields.title,
      description: fields.description,
      rationale: fields.rationale,
      problem: null,
      resolution: null,
      alternatives: null,
      tier: "personal",
      status: "active",
      superseded_by: null,
      author: "test",
      provenance: null,
      created_at: now,
      updated_at: now,
    };
    repo_d.insert(rec);
    return id;
  } finally {
    db.close();
  }
}

function linkDecision(
  repo: string,
  decisionId: string,
  target: string,
  relation: Relation,
): void {
  const db = openDecisionsDb(decisionsDbPath(repo));
  try {
    const links = new DecisionLinksRepository(db);
    links.add({
      decision_id: decisionId,
      target_kind: target.includes("/") ? "path" : "qn",
      target_ref: target,
      relation,
      created_at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

function getDecisionFromRepo(repo: string, id: string): DecisionRecord | undefined {
  const db = openDecisionsDb(decisionsDbPath(repo));
  try {
    return new DecisionsRepository(db).get(id) ?? undefined;
  } finally {
    db.close();
  }
}

function getDecisionLinks(repo: string, id: string) {
  const db = openDecisionsDb(decisionsDbPath(repo));
  try {
    return new DecisionLinksRepository(db).findByDecision(id);
  } finally {
    db.close();
  }
}

function runRehome(
  sourceRepo: string,
  args: string[],
  opts: { expectThrow?: boolean } = {},
): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX, [CLI, "decision", "rehome", ...args], {
      cwd: sourceRepo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "" };
  } catch (e) {
    if (opts.expectThrow) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message: string };
      return {
        stdout: typeof err.stdout === "string" ? err.stdout : err.stdout?.toString() ?? "",
        stderr: typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "",
      };
    }
    throw e;
  }
}

describe("cortex decision rehome — happy path", () => {
  it("moves a decision from source repo to target repo, preserving id and links", () => {
    const source = makeIndexedRepoFixture();
    const target = makeIndexedRepoFixture();
    try {
      const id = createDecisionInRepo(source, {
        title: "x", description: "y", rationale: "z",
      });
      linkDecision(source, id, "src/auth.ts", "GOVERNS");

      runRehome(source, [id, `--to=${target}`]);

      expect(getDecisionFromRepo(source, id)).toBeUndefined();
      const moved = getDecisionFromRepo(target, id);
      expect(moved).toBeDefined();
      expect(moved!.title).toBe("x");
      expect(getDecisionLinks(target, id)).toHaveLength(1);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("cortex decision rehome — error paths", () => {
  it("errors when id is not in source repo", () => {
    const source = makeIndexedRepoFixture();
    const target = makeIndexedRepoFixture();
    try {
      const { stderr } = runRehome(
        source,
        ["nonexistent-id", `--to=${target}`],
        { expectThrow: true },
      );
      expect(stderr).toMatch(/no decision 'nonexistent-id'/);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("errors when id already exists in target repo", () => {
    const source = makeIndexedRepoFixture();
    const target = makeIndexedRepoFixture();
    try {
      const id = createDecisionInRepo(source, {
        title: "x", description: "y", rationale: "z",
      });
      createDecisionInRepo(
        target,
        { title: "preexisting", description: "y", rationale: "z" },
        { id },
      );
      const { stderr } = runRehome(
        source,
        [id, `--to=${target}`],
        { expectThrow: true },
      );
      expect(stderr).toMatch(/already exists in target/);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("errors when target repo is not indexed", () => {
    const source = makeIndexedRepoFixture();
    const unindexed = mkdtempSync(join(tmpdir(), "unindexed-"));
    execFileSync("git", ["init", "-q"], { cwd: unindexed, stdio: "ignore" });
    try {
      const id = createDecisionInRepo(source, {
        title: "x", description: "y", rationale: "z",
      });
      const { stderr } = runRehome(
        source,
        [id, `--to=${unindexed}`],
        { expectThrow: true },
      );
      expect(stderr).toMatch(/isn't indexed/);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(unindexed, { recursive: true, force: true });
    }
  });

  it("--dry-run prints the move plan without modifying either DB", () => {
    const source = makeIndexedRepoFixture();
    const target = makeIndexedRepoFixture();
    try {
      const id = createDecisionInRepo(source, {
        title: "x", description: "y", rationale: "z",
      });
      runRehome(source, [id, `--to=${target}`, "--dry-run"]);
      expect(getDecisionFromRepo(source, id)).toBeDefined();
      expect(getDecisionFromRepo(target, id)).toBeUndefined();
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
