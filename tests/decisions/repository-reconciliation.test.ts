import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository, type DecisionRecord } from "../../src/decisions/repository.js";

function rec(id: string): DecisionRecord {
  return {
    id,
    title: "t",
    description: null,
    rationale: null,
    problem: null,
    resolution: null,
    alternatives: null,
    tier: "personal",
    status: "active",
    superseded_by: null,
    author: null,
    provenance: null,
    created_at: "t",
    updated_at: "t",
  };
}

describe("DecisionsRepository reconciliation", () => {
  it("records a verdict and reads it back via get()", () => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "repo-")), "d.db"));
    const repo = new DecisionsRepository(db);
    repo.insert(rec("d1"));
    repo.recordReconciliation("d1", {
      reconciliation_verdict: "drift",
      reconciled_at: "2026-06-08T00:00:00Z",
      reconciled_source_hash: "abc123",
      reconciled_by: "claude-opus-4-8",
      nonconformant_nodes: JSON.stringify([{ ref: "src/x.ts", note: "renamed" }]),
      reconciliation_note: "function gone",
    });
    const got = repo.get("d1")!;
    expect(got.reconciliation_verdict).toBe("drift");
    expect(got.reconciled_source_hash).toBe("abc123");
    expect(got.reconciled_by).toBe("claude-opus-4-8");
    db.close();
  });

  it("get() returns null reconciliation fields for an unjudged decision", () => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "repo-")), "d.db"));
    const repo = new DecisionsRepository(db);
    repo.insert(rec("d2"));
    const got = repo.get("d2")!;
    expect(got.reconciliation_verdict ?? null).toBeNull();
    expect(got.reconciled_at ?? null).toBeNull();
    db.close();
  });
});
