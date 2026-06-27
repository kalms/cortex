import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../../src/decisions/db.js";
import { DecisionsRepository } from "../../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../../src/decisions/links-repository.js";
import { DecisionService } from "../../../src/decisions/service.js";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

describe("cortex decision list reads the resolved live store", () => {
  it("surfaces a decision written at resolveDecisionsDbPath (honors CORTEX_DECISIONS_DB)", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-dec-live-"));
    // Make the dir look like a git repo so the no-project guard passes.
    mkdirSync(join(root, ".git"));
    const dbPath = join(root, "decisions.db");
    try {
      const db = openDecisionsDb(dbPath);
      new DecisionService({ db, decisions: new DecisionsRepository(db), links: new DecisionLinksRepository(db) })
        .create({ title: "Live store wins", description: "d", rationale: "r" });
      db.close();
      // Without the fix, the CLI reads <cwd>/.cortex/decisions.db and ignores
      // this override → output would be empty and this assertion fails.
      const out = execFileSync(TSX, [CLI, "decision", "list", "--format=plain"], {
        cwd: root, encoding: "utf-8", env: { ...process.env, CORTEX_DECISIONS_DB: dbPath },
      });
      expect(out).toContain("Live store wins");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
