import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernedRefs } from "../../src/decisions/reconciliation.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "cortex-refs-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("resolveGovernedRefs", () => {
  it("reports resolved, missing and unresolvable distinctly", () => {
    const d = tmp();
    writeFileSync(join(d, "there.ts"), "x");
    const out = resolveGovernedRefs(d, [
      { target_kind: "path", target_ref: "there.ts" },
      { target_kind: "path", target_ref: "gone.ts" },
      { target_kind: "decision", target_ref: "D-abcd" },
    ]);
    expect(out.map((r) => r.state)).toEqual(["resolved", "missing", "unresolvable"]);
    expect(out[0].path).toBe("there.ts");
    expect(out[2].path).toBeNull();
  });

  it("resolves against the repo path it is given", () => {
    const a = tmp(); const b = tmp();
    writeFileSync(join(a, "only-in-a.ts"), "x");
    const refs = [{ target_kind: "path", target_ref: "only-in-a.ts" }];
    expect(resolveGovernedRefs(a, refs)[0].state).toBe("resolved");
    expect(resolveGovernedRefs(b, refs)[0].state).toBe("missing");
  });

  it("returns an empty array for no refs", () => {
    expect(resolveGovernedRefs(tmp(), [])).toEqual([]);
  });
});
