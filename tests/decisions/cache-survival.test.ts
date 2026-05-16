import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("decisions survive index_repository cache import", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "cortex-cache-survival-"));
    execSync("git init", { cwd: repoDir });
    writeFileSync(join(repoDir, "hello.ts"), 'export const hello = "world";\n');
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -m 'init'", { cwd: repoDir });
  });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  it("a decision created before index_repository survives a subsequent cache import", () => {
    // 1. Create a decision against the repo via the sidecar DB.
    const decPath = resolveDecisionsDbPath(repoDir);
    const db = openDecisionsDb(decPath);
    const svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
    const d = svc.create({ title: "Use vitest", description: "x", rationale: "y" });
    db.close();

    // 2. Simulate the cache-import codepath that previously destroyed decisions:
    //    overwrite <repo>/.cortex/graph.db. The decisions.db is a separate file
    //    and must NOT be touched.
    const cortexDir = join(repoDir, ".cortex");
    mkdirSync(cortexDir, { recursive: true });
    writeFileSync(join(cortexDir, "graph.db"), Buffer.from([0x00, 0x01, 0x02]));

    // 3. Re-open decisions.db and confirm the decision is still there.
    const db2 = openDecisionsDb(decPath);
    try {
      const got = new DecisionsRepository(db2).get(d.id);
      expect(got?.title).toBe("Use vitest");
    } finally {
      db2.close();
    }
  });
});
