import { vi, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeBriefing } from "../../src/briefing/compose.js";
import { hashGovernedSource } from "../../src/decisions/reconciliation.js";
import { blastRadius } from "../../src/briefing/blast-radius.js";
import type { BriefingDeps } from "../../src/briefing/types.js";

// Mirrors tests/briefing/compose.test.ts: the graph store is out of scope here,
// so fan-out is mocked and the gate is the governing decision.
vi.mock("../../src/briefing/blast-radius.js", () => ({ blastRadius: vi.fn() }));

const REF = { target_kind: "path", target_ref: "src/a.ts" };

function tree(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-brief-basis-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), body);
  return root;
}

/** Minimal stand-ins — composeBriefing only touches these four surfaces. */
function deps(
  root: string,
  basis: string | null,
  over: { verdict?: string; reconciled?: string | null } = {},
): BriefingDeps {
  const decision = { id: "D-aaaa", title: "governs a", status: "active" };
  return {
    repoPath: root,
    search: { findGoverning: () => [decision] } as never,
    decisions: {
      get: () => ({
        ...decision,
        reconciliation_verdict: over.verdict ?? "match",
        basis_hash: basis,
        reconciled_source_hash: over.reconciled ?? null,
      }),
    } as never,
    links: { findByDecision: () => [{ ...REF, relation: "GOVERNS" }] } as never,
    store: {} as never,
    project: "p",
  };
}

/** Two active governing decisions over the same target, both verdict `match`;
 *  `first` is listed first and its basis is current. */
function twoDeps(root: string, firstBasis: string, secondBasis: string): BriefingDeps {
  const a = { id: "D-first", title: "first", status: "active" };
  const b = { id: "D-secnd", title: "second", status: "active" };
  const basis: Record<string, string> = { "D-first": firstBasis, "D-secnd": secondBasis };
  return {
    repoPath: root,
    search: { findGoverning: () => [a, b] } as never,
    decisions: {
      get: (id: string) => ({
        id, title: id, status: "active",
        reconciliation_verdict: "match", basis_hash: basis[id], reconciled_source_hash: null,
      }),
    } as never,
    links: { findByDecision: () => [{ ...REF, relation: "GOVERNS" }] } as never,
    store: {} as never,
    project: "p",
  };
}

describe("briefing basis-moved line", () => {
  it("warns when the basis moved since the decision was authored", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const basis = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const b = composeBriefing(deps(root, basis), "src/a.ts");
    expect(b.gated).toBe(true);
    expect(b.headline).toContain("moved since this was last judged");
    // A `match` verdict whose basis moved must still escalate — that is the
    // row that reads clean while being wrong.
    expect(b.escalate).toBe(true);
  });

  it("stays quiet when the basis is unchanged", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const b = composeBriefing(deps(root, hashGovernedSource(root, [REF])), "src/a.ts");
    expect(b.headline).not.toContain("moved since this was last judged");
    expect(b.escalate).toBe(false);
  });

  it("stays quiet when there is no reference point at all", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const b = composeBriefing(deps(root, null), "src/a.ts");
    expect(b.headline).not.toContain("moved since this was last judged");
  });

  it("stays quiet once a verdict has been recorded against THIS tree", () => {
    // Reconciliation moves basis_hash only on `match`, so an honest `drift`
    // verdict leaves the basis stale forever. Without this rule the line would
    // re-fire on every read after the agent did exactly what it asked for.
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const authored = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const judged = hashGovernedSource(root, [REF]);
    const b = composeBriefing(deps(root, authored, { verdict: "drift", reconciled: judged }), "src/a.ts");
    expect(b.headline).not.toContain("moved since this was last judged");
  });

  it("fires when the verdict was recorded against a DIFFERENT tree", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const current = hashGovernedSource(root, [REF]);
    const b = composeBriefing(
      deps(root, current, { verdict: "match", reconciled: "0".repeat(64) }),
      "src/a.ts",
    );
    expect(b.headline).toContain("moved since this was last judged");
  });

  it("a current-basis decision cannot hide a moved-basis one at the same rank", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const stale = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    const current = hashGovernedSource(root, [REF]);
    // D-first is listed first and is clean; D-secnd's basis moved.
    const b = composeBriefing(twoDeps(root, current, stale), "src/a.ts");
    expect(b.headline).toContain("moved since this was last judged");
    expect(b.escalate).toBe(true);
  });

  it("CORTEX_STALENESS=0 silences the line without touching the rest of the briefing", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const authored = hashGovernedSource(root, [REF]);
    writeFileSync(join(root, "src", "a.ts"), "v2\n");
    process.env.CORTEX_STALENESS = "0";
    try {
      const b = composeBriefing(deps(root, authored), "src/a.ts");
      expect(b.headline).not.toContain("moved since this was last judged");
      expect(b.gated).toBe(true);           // still gated by the governing decision
      expect(b.headline).toContain("D-aaaa");
    } finally { delete process.env.CORTEX_STALENESS; }
  });
});