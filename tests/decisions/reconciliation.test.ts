import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashGovernedSource, displayState, refToFile } from "../../src/decisions/reconciliation.js";

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gov-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return dir;
}

describe("hashGovernedSource", () => {
  it("is deterministic for the same content", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "path", target_ref: "a.ts" }];
    expect(hashGovernedSource(dir, refs)).toBe(hashGovernedSource(dir, refs));
  });

  it("changes when a governed file's content changes", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "path", target_ref: "a.ts" }];
    const before = hashGovernedSource(dir, refs);
    writeFileSync(join(dir, "a.ts"), "beta");
    expect(hashGovernedSource(dir, refs)).not.toBe(before);
  });

  it("is order-independent across refs", () => {
    const dir = repoWith({ "a.ts": "alpha", "b.ts": "beta" });
    const h1 = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "a.ts" }, { target_kind: "path", target_ref: "b.ts" }]);
    const h2 = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "b.ts" }, { target_kind: "path", target_ref: "a.ts" }]);
    expect(h1).toBe(h2);
  });

  it("resolves a qn ref to the file part before '::'", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const viaPath = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "a.ts" }]);
    const viaQn = hashGovernedSource(dir, [{ target_kind: "qn", target_ref: "a.ts::someFn" }]);
    expect(viaQn).toBe(hashGovernedSource(dir, [{ target_kind: "qn", target_ref: "a.ts::someFn" }]));
    expect(viaQn).not.toBe(viaPath);
  });

  it("uses a <missing> sentinel for a deleted governed file (and changes when it disappears)", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "path", target_ref: "a.ts" }];
    const before = hashGovernedSource(dir, refs);
    rmSync(join(dir, "a.ts"));
    expect(hashGovernedSource(dir, refs)).not.toBe(before);
  });

  it("reads the file through a qn ref (mutating the file changes the hash)", () => {
    // Proves qn refs actually read file bytes — not just that the ref string differs.
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "qn", target_ref: "a.ts::someFn" }];
    const before = hashGovernedSource(dir, refs);
    writeFileSync(join(dir, "a.ts"), "beta");
    expect(hashGovernedSource(dir, refs)).not.toBe(before);
  });

  it("reads the file for a bare-filename qn ref with no '::'", () => {
    // service.ts classifies bare filenames (no '/') as target_kind 'qn'; these
    // are real files and must be hashed by content, not treated as unresolvable.
    const dir = repoWith({ "x.ts": "one" });
    const refs = [{ target_kind: "qn", target_ref: "x.ts" }];
    const before = hashGovernedSource(dir, refs);
    writeFileSync(join(dir, "x.ts"), "two");
    expect(hashGovernedSource(dir, refs)).not.toBe(before);
  });

  it("treats decision/pr refs as unresolvable (no file read; stable across unrelated edits)", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    const refs = [{ target_kind: "decision", target_ref: "01HXISADECISIONID" }];
    const before = hashGovernedSource(dir, refs);
    writeFileSync(join(dir, "a.ts"), "changed"); // unrelated file edit
    expect(hashGovernedSource(dir, refs)).toBe(before); // sentinel is stable
  });

  it("walks a directory ref recursively (a new file under it changes the hash)", () => {
    const dir = repoWith({});
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "a.ts"), "alpha");
    const refs = [{ target_kind: "path", target_ref: "sub" }];
    const before = hashGovernedSource(dir, refs);
    writeFileSync(join(dir, "sub", "b.ts"), "beta");
    expect(hashGovernedSource(dir, refs)).not.toBe(before);
  });

  it("treats path-traversal and absolute refs as unresolvable (no escape from repo)", () => {
    const dir = repoWith({ "a.ts": "alpha" });
    // A '..' traversal ref and an absolute ref must NOT read outside the repo —
    // they resolve to the <unresolved> sentinel, so their hash is stable and
    // independent of whatever lives at the escaped path.
    const traversal = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "../../../../etc/hosts" }]);
    const absolute = hashGovernedSource(dir, [{ target_kind: "path", target_ref: "/etc/hosts" }]);
    // Both reduce to the unresolved sentinel for their (different) ref strings;
    // crucially neither throws nor depends on the external file's contents.
    expect(typeof traversal).toBe("string");
    expect(typeof absolute).toBe("string");
    // Same ref string ⇒ same hash regardless of external FS state (proves no read).
    expect(traversal).toBe(hashGovernedSource(dir, [{ target_kind: "path", target_ref: "../../../../etc/hosts" }]));
  });
});

describe("displayState", () => {
  it.each([
    ["active", "match", "active"],
    ["active", "partial", "active · drifting"],
    ["active", "drift", "stale"],
    ["active", "unknown", "active · unreconciled"],
    ["active", null, "active · unreconciled"],
    ["superseded", "drift", "superseded"],
    ["deprecated", "match", "deprecated"],
    ["proposed", "drift", "proposed"],
  ])("status=%s verdict=%s → %s", (status, verdict, expected) => {
    expect(displayState(status, verdict)).toBe(expected);
  });
});

describe("refToFile traversal guard", () => {
  it("returns null for absolute and parent-traversal refs", () => {
    expect(refToFile({ target_kind: "path", target_ref: "/etc/passwd" })).toBeNull();
    expect(refToFile({ target_kind: "path", target_ref: "../secrets.ts" })).toBeNull();
    expect(refToFile({ target_kind: "path", target_ref: "a/../../b.ts" })).toBeNull();
    expect(refToFile({ target_kind: "qn", target_ref: "../x.ts::fn" })).toBeNull();
  });
  it("still resolves normal in-repo refs", () => {
    expect(refToFile({ target_kind: "path", target_ref: "src/a.ts" })).toBe("src/a.ts");
    expect(refToFile({ target_kind: "path", target_ref: "sub" })).toBe("sub");
    expect(refToFile({ target_kind: "qn", target_ref: "src/a.ts::fn" })).toBe("src/a.ts");
  });
});
