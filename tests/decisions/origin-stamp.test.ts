import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "cortex-stamp-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("origin stamping at the repository layer", () => {
  it("persists origin fields given on insert", () => {
    const db = openDecisionsDb(join(tmp(), "decisions.db"));
    const repo = new DecisionsRepository(db);
    repo.insert({
      id: "D-a1", title: "t", description: null, rationale: null, problem: null, resolution: null,
      alternatives: null, tier: "personal", status: "active", superseded_by: null, author: "claude",
      provenance: null, created_at: "2026-01-01", updated_at: "2026-01-01",
      origin_branch: "feature/x", origin_commit: "abc123", origin_thread: "thread-7",
      last_touched_branch: "feature/x", last_touched_commit: "abc123", last_touched_thread: "thread-7",
      basis_hash: null,
    } as never);
    const row = db.prepare("SELECT * FROM decisions WHERE id='D-a1'").get() as Record<string, unknown>;
    expect(row.origin_branch).toBe("feature/x");
    expect(row.origin_commit).toBe("abc123");
    expect(row.origin_thread).toBe("thread-7");
    expect(row.last_touched_branch).toBe("feature/x");
    db.close();
  });

  it("leaves origin NULL when not supplied", () => {
    const db = openDecisionsDb(join(tmp(), "decisions.db"));
    const repo = new DecisionsRepository(db);
    repo.insert({
      id: "D-a2", title: "t", description: null, rationale: null, problem: null, resolution: null,
      alternatives: null, tier: "personal", status: "active", superseded_by: null, author: null,
      provenance: null, created_at: "2026-01-01", updated_at: "2026-01-01",
    } as never);
    const row = db.prepare("SELECT * FROM decisions WHERE id='D-a2'").get() as Record<string, unknown>;
    expect(row.origin_branch).toBeNull();
    expect(row.basis_hash).toBeNull();
    db.close();
  });
});
