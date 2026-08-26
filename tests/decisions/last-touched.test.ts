import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "cortex-touch-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function seed(): { db: ReturnType<typeof openDecisionsDb>; repo: DecisionsRepository } {
  const db = openDecisionsDb(join(tmp(), "decisions.db"));
  const repo = new DecisionsRepository(db);
  repo.insert({
    id: "D-t1", title: "t", description: null, rationale: null, problem: null, resolution: null,
    alternatives: null, tier: "personal", status: "active", superseded_by: null, author: null,
    provenance: null, created_at: "2026-01-01", updated_at: "2026-01-01",
    origin_branch: "feature/orig", origin_commit: "aaa", origin_thread: "th-1",
    last_touched_branch: "feature/orig", last_touched_commit: "aaa", last_touched_thread: "th-1",
  } as never);
  return { db, repo };
}

describe("last-touched", () => {
  it("update rewrites last-touched and leaves origin alone", () => {
    const { db, repo } = seed();
    repo.update("D-t1", {
      title: "t2", updated_at: "2026-02-02",
      last_touched_branch: "feature/later", last_touched_commit: "bbb", last_touched_thread: "th-2",
    } as never);
    const row = db.prepare("SELECT * FROM decisions WHERE id='D-t1'").get() as Record<string, unknown>;
    expect(row.last_touched_branch).toBe("feature/later");
    expect(row.last_touched_commit).toBe("bbb");
    expect(row.origin_branch).toBe("feature/orig");   // immutable
    expect(row.origin_commit).toBe("aaa");
    db.close();
  });

  it("recordReconciliation stamps reconciled_branch/commit and last-touched", () => {
    const { db, repo } = seed();
    repo.recordReconciliation("D-t1", {
      reconciliation_verdict: "match", reconciled_at: "2026-02-02",
      reconciled_source_hash: "f".repeat(64), reconciled_by: "claude",
      nonconformant_nodes: null, reconciliation_note: null,
      reconciled_branch: "feature/later", reconciled_commit: "bbb",
      last_touched_branch: "feature/later", last_touched_commit: "bbb", last_touched_thread: null,
    } as never);
    const row = db.prepare("SELECT * FROM decisions WHERE id='D-t1'").get() as Record<string, unknown>;
    expect(row.reconciled_branch).toBe("feature/later");
    expect(row.reconciled_commit).toBe("bbb");
    expect(row.last_touched_branch).toBe("feature/later");
    expect(row.origin_branch).toBe("feature/orig");
    db.close();
  });
});
