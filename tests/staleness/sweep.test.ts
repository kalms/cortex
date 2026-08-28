import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleness, concludedBranches } from "../../src/staleness/sweep.js";
import { hashGovernedSource } from "../../src/decisions/reconciliation.js";
import type { SweepCandidate, SweepInput } from "../../src/staleness/types.js";

const REF = { target_kind: "path", target_ref: "src/a.ts" };
const NOW = () => new Date("2026-08-28T00:00:00.000Z");

function tree(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-sweep-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), body);
  return root;
}

function candidate(over: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    kind: "decision", id: "D-aaaa", title: "a decision", status_active: true,
    refs: [REF], basis_hash: null, reconciled_source_hash: null,
    origin_branch: "feature/x", origin_commit: "abc1234", origin_thread: null,
    ...over,
  };
}

function input(root: string, candidates: SweepCandidate[], over: Partial<SweepInput> = {}): SweepInput {
  return {
    repoPath: root, candidates, originBranches: ["feature/x"],
    knownBranches: new Set(["main", "feature/x"]),
    changedFiles: new Set(["src/a.ts"]), sinceCommit: "base1234",
    headCommit: "head1234", now: NOW, ...over,
  };
}

describe("sweepStaleness — the three populations", () => {
  it("counts a NULL-basis row and never itemizes it", () => {
    const root = tree("v1\n");
    const r = sweepStaleness(input(root, [candidate({ basis_hash: null })]));
    expect(r.counts.no_reference_point).toBe(1);
    expect(r.itemized).toHaveLength(0);
  });

  it("itemizes a row whose basis moved and whose ref changed", () => {
    const root = tree("v1\n");
    const stale = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const r = sweepStaleness(input(root, [candidate({ basis_hash: stale })]));
    expect(r.itemized).toHaveLength(1);
    expect(r.itemized[0].reason).toBe("basis_moved");
    expect(r.counts.basis_moved).toBe(1);
    expect(r.counts.outstanding).toBe(0);
  });

  it("itemizes nothing when the basis is unchanged", () => {
    const root = tree("v1\n");
    const current = hashGovernedSource(root, [REF]);
    const r = sweepStaleness(input(root, [candidate({ basis_hash: current })]));
    expect(r.itemized).toHaveLength(0);
    expect(r.counts.basis_moved).toBe(0);
  });

  it("itemizes a stale verdict independently of the basis", () => {
    const root = tree("v1\n");
    const current = hashGovernedSource(root, [REF]);
    const r = sweepStaleness(input(root, [
      candidate({ basis_hash: current, reconciled_source_hash: "0".repeat(64) }),
    ]));
    expect(r.itemized).toHaveLength(1);
    expect(r.itemized[0].reason).toBe("verdict_stale");
    expect(r.counts.verdict_stale).toBe(1);
  });

  it("counts a flagged row as outstanding when its refs did not change this index", () => {
    const root = tree("v1\n");
    const stale = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const r = sweepStaleness(input(root, [candidate({ basis_hash: stale })], {
      changedFiles: new Set(["src/unrelated.ts"]),
    }));
    expect(r.itemized).toHaveLength(0);
    expect(r.counts.outstanding).toBe(1);
    expect(r.counts.basis_moved).toBe(1);
  });

  it("itemizes nothing on a first index (no previous baseline)", () => {
    const root = tree("v1\n");
    const stale = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const r = sweepStaleness(input(root, [candidate({ basis_hash: stale })], {
      sinceCommit: null, changedFiles: null,
    }));
    expect(r.itemized).toHaveLength(0);
    expect(r.counts.outstanding).toBe(1);
  });

  it("skips inactive rows and rows that govern nothing", () => {
    const root = tree("v1\n");
    const stale = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const r = sweepStaleness(input(root, [
      candidate({ id: "D-inac", basis_hash: stale, status_active: false }),
      candidate({ id: "D-decl", basis_hash: stale, refs: [] }),
    ]));
    expect(r.itemized).toHaveLength(0);
    expect(r.counts.basis_moved).toBe(0);
    expect(r.counts.no_reference_point).toBe(0);
  });

  it("counts a row flagged for both reasons once in outstanding math", () => {
    const root = tree("v1\n");
    const stale = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const r = sweepStaleness(input(root, [
      candidate({ basis_hash: stale, reconciled_source_hash: "0".repeat(64) }),
    ], { changedFiles: new Set(["src/unrelated.ts"]) }));
    expect(r.counts.basis_moved).toBe(1);
    expect(r.counts.verdict_stale).toBe(1);
    expect(r.counts.outstanding).toBe(1); // ONE row, not two
  });

  it("matches a directory ref against a changed file beneath it", () => {
    const root = tree("v1\n");
    const dirRef = { target_kind: "path", target_ref: "src" };
    const stale = hashGovernedSource(root, [dirRef]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const r = sweepStaleness(input(root, [candidate({ refs: [dirRef], basis_hash: stale })], {
      changedFiles: new Set(["src/a.ts"]),
    }));
    expect(r.itemized).toHaveLength(1);
  });
});

describe("concludedBranches — the C4 set difference", () => {
  it("flags a branch git no longer knows", () => {
    expect(concludedBranches(["gone", "main"], new Set(["main"]))).toEqual(["gone"]);
  });
  it("does NOT flag a branch present only as a remote-tracking ref", () => {
    expect(concludedBranches(["landed"], new Set(["main", "landed"]))).toEqual([]);
  });
  it("concludes nothing when git could not answer", () => {
    expect(concludedBranches(["gone"], null)).toEqual([]);
  });
});

describe("sweepStaleness — a verdict recorded against this tree settles the row", () => {
  it("does NOT flag a row whose drift verdict was recorded against the current tree", () => {
    // Reconciliation moves basis_hash only on `match`, so a `drift` verdict
    // leaves the basis permanently stale. Without this rule the row is
    // re-flagged on every index forever and can only be silenced by recording
    // a `match` nobody believes.
    const root = tree("v1\n");
    const authored = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const judged = hashGovernedSource(root, [REF]);
    const r = sweepStaleness(input(root, [
      candidate({ basis_hash: authored, reconciled_source_hash: judged }),
    ]));
    expect(r.itemized).toHaveLength(0);
    expect(r.counts.basis_moved).toBe(0);
    expect(r.counts.outstanding).toBe(0);
  });

  it("DOES flag it again once the tree moves past the judged state", () => {
    const root = tree("v1\n");
    const authored = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const judged = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v3\n");
    const r = sweepStaleness(input(root, [
      candidate({ basis_hash: authored, reconciled_source_hash: judged }),
    ]));
    expect(r.itemized).toHaveLength(1);
  });
});

describe("sweepStaleness — orphan detection", () => {
  it("marks a row orphaned only when the branch is gone AND a ref is unresolvable", () => {
    // The governed file must EXIST when the basis is taken and be gone now.
    // Hashing an already-missing ref bakes the <missing> sentinel into the
    // basis, so the hash compares equal forever and the row never flags —
    // the row reads clean while governing code that does not exist.
    const root = tree("v1\n");
    const deletedRef = { target_kind: "path", target_ref: "src/deleted.ts" };
    writeFileSync(join(root, "src", "deleted.ts"), "export const d = 1;\n");
    const stale = hashGovernedSource(root, [deletedRef]);
    rmSync(join(root, "src", "deleted.ts"));
    const r = sweepStaleness(input(root, [
      candidate({ refs: [deletedRef], basis_hash: stale, origin_branch: "gone" }),
    ], {
      originBranches: ["gone"], knownBranches: new Set(["main"]),
      changedFiles: new Set(["src/deleted.ts"]),
    }));
    expect(r.concluded_branches).toEqual(["gone"]);
    expect(r.itemized[0].unresolved_refs).toEqual(["src/deleted.ts"]);
    expect(r.orphaned).toEqual([{ kind: "decision", id: "D-aaaa", origin_branch: "gone" }]);
  });

  it("reports an orphan whose governed file can never appear in a git diff", () => {
    // An orphan's governed file usually does not exist, so it is absent from
    // every changed-file set. Scoping orphan detection to `itemized` would make
    // it permanently empty for exactly the population it was built to find.
    const root = tree("v1\n");
    const deletedRef = { target_kind: "path", target_ref: "src/deleted.ts" };
    writeFileSync(join(root, "src", "deleted.ts"), "export const d = 1;\n");
    const stale = hashGovernedSource(root, [deletedRef]);
    rmSync(join(root, "src", "deleted.ts"));
    const r = sweepStaleness(input(root, [
      candidate({ refs: [deletedRef], basis_hash: stale, origin_branch: "gone" }),
    ], {
      originBranches: ["gone"], knownBranches: new Set(["main"]),
      changedFiles: new Set(["src/something-else.ts"]), // the deleted file is NOT here
    }));
    expect(r.itemized).toHaveLength(0);      // correctly out of itemization scope
    expect(r.counts.outstanding).toBe(1);
    expect(r.orphaned).toEqual([{ kind: "decision", id: "D-aaaa", origin_branch: "gone" }]);
  });

  it("does not orphan a concluded branch whose refs all resolve", () => {
    const root = tree("v1\n");
    const stale = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const r = sweepStaleness(input(root, [candidate({ basis_hash: stale, origin_branch: "gone" })], {
      originBranches: ["gone"], knownBranches: new Set(["main"]),
    }));
    expect(r.itemized[0].branch_concluded).toBe(true);
    expect(r.orphaned).toEqual([]);
  });
});
