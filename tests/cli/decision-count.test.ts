import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

const CLI = join(process.cwd(), "src/cli/main.ts");
// Direct path to tsx — faster than `npx tsx` and avoids PATH dependency.
const TSX = join(process.cwd(), "node_modules/.bin/tsx");

function runCli(cwd: string, env: Record<string, string> = {}): string {
  return execFileSync(TSX, [CLI, "decision", "count"], {
    cwd, encoding: "utf-8", env: { ...process.env, ...env },
  }).trim();
}

describe("cortex decision count", () => {
  it("prints 0 in a repo with no decisions", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-count-"));
    try {
      mkdirSync(join(root, ".git")); // make it look like a git repo for context
      expect(runCli(root)).toBe("0");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prints the number of decisions present", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-count-"));
    try {
      mkdirSync(join(root, ".git"));
      const dbPath = join(root, "decisions.db");
      const db = openDecisionsDb(dbPath);
      const service = new DecisionService({
        db,
        decisions: new DecisionsRepository(db),
        links: new DecisionLinksRepository(db),
      });
      service.create({ title: "a", description: "d", rationale: "r" });
      service.create({ title: "b", description: "d", rationale: "r" });
      db.close();
      expect(runCli(root, { CORTEX_DECISIONS_DB: dbPath })).toBe("2");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prints 0 when there is no git repo (no-project safe)", () => {
    // The SessionStart hook calls this command in any cwd; if the cwd has no
    // .git ancestor, the handler must still print "0" without erroring so
    // the hook can branch cleanly. /tmp has no git ancestor on macOS.
    const root = mkdtempSync(join(tmpdir(), "cortex-count-norepo-"));
    try {
      expect(runCli(root)).toBe("0");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
