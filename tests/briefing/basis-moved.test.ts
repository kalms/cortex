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
function deps(root: string, basis: string | null, verdict = "match"): BriefingDeps {
  const decision = { id: "D-aaaa", title: "governs a", status: "active" };
  return {
    repoPath: root,
    search: { findGoverning: () => [decision] } as never,
    decisions: { get: () => ({ ...decision, reconciliation_verdict: verdict, basis_hash: basis }) } as never,
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
    expect(b.headline).toContain("basis moved");
    // A `match` verdict whose basis moved must still escalate — that is the
    // row that reads clean while being wrong.
    expect(b.escalate).toBe(true);
  });

  it("stays quiet when the basis is unchanged", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const b = composeBriefing(deps(root, hashGovernedSource(root, [REF])), "src/a.ts");
    expect(b.headline).not.toContain("basis moved");
    expect(b.escalate).toBe(false);
  });

  it("stays quiet when there is no reference point at all", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const root = tree("v1\n");
    const b = composeBriefing(deps(root, null), "src/a.ts");
    expect(b.headline).not.toContain("basis moved");
  });
});
