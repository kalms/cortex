// tests/frame-extraction/co-change.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { collectCoChange, parseCoChangeLog } from "../../scripts/frame-extraction/co-change.js";

let root: string;
let renameRoot: string;

function git(args: string, opts: { cwd: string }) {
  return execSync(`git ${args}`, { ...opts, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(repo: string, message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(repo, path.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    writeFileSync(full, content);
    git(`add ${path}`, { cwd: repo });
  }
  git(`-c user.email=test@example.com -c user.name=test commit -m "${message}"`, { cwd: repo });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-co-change-"));
  git("init -q", { cwd: root });
  // Commit 1: a + b touched together
  commit(root, "feat: auth", { "src/auth.ts": "x", "src/middleware.ts": "x" });
  // Commit 2: a + b touched together again
  commit(root, "fix: auth", { "src/auth.ts": "y", "src/middleware.ts": "y" });
  // Commit 3: a + c touched (b not touched)
  commit(root, "feat: c", { "src/auth.ts": "z", "src/api.ts": "x" });
  // Commit 4: only c (no pair generated)
  commit(root, "tweak: c", { "src/api.ts": "y" });
  // Commit 5: huge format-pass commit (60 files) — should be dropped
  const big: Record<string, string> = {};
  for (let i = 0; i < 60; i++) big[`big/f${i}.txt`] = "x";
  commit(root, "chore: format", big);

  // Second fixture: rename scenarios.
  renameRoot = mkdtempSync(join(tmpdir(), "cortex-co-change-rename-"));
  git("init -q", { cwd: renameRoot });
  // C1: create a + partner together (>50% identical content so git's
  // rename detection has a stable signal across the rename commit).
  const longText = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";
  commit(renameRoot, "init", { "src/a.ts": longText, "src/partner.ts": longText + "p1\n" });
  // C2: rename a.ts → lib/a.ts (preserve content) AND modify partner.
  mkdirSync(join(renameRoot, "lib"), { recursive: true });
  git(`mv src/a.ts lib/a.ts`, { cwd: renameRoot });
  writeFileSync(join(renameRoot, "src/partner.ts"), longText + "p2\n");
  git("add -A", { cwd: renameRoot });
  git(`-c user.email=t -c user.name=t commit -m "rename a"`, { cwd: renameRoot });
  // C3: modify the renamed file + partner.
  writeFileSync(join(renameRoot, "lib/a.ts"), longText + "edit\n");
  writeFileSync(join(renameRoot, "src/partner.ts"), longText + "p3\n");
  git("add -A", { cwd: renameRoot });
  git(`-c user.email=t -c user.name=t commit -m "edit renamed"`, { cwd: renameRoot });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(renameRoot, { recursive: true, force: true });
});

// Test fixtures use full 40-char SHAs because parseCoChangeLog requires
// exactly that length — git log --pretty=format:%H always emits the full SHA.
const SHA_A = "0000000000000000000000000000000000000001";
const SHA_B = "0000000000000000000000000000000000000002";
const SHA_C = "0000000000000000000000000000000000000003";

describe("parseCoChangeLog (pure, --name-status format)", () => {
  it("yields one pair per file-pair per commit", () => {
    const log =
      `${SHA_A}\n` +
      "M\tsrc/auth.ts\n" +
      "M\tsrc/middleware.ts\n" +
      "\n" +
      `${SHA_B}\n` +
      "M\tsrc/auth.ts\n" +
      "M\tsrc/middleware.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ a: "src/auth.ts", b: "src/middleware.ts", count: 1 });
    expect(pairs[1]).toEqual({ a: "src/auth.ts", b: "src/middleware.ts", count: 1 });
  });

  it("drops commits with >= big_commit_threshold files", () => {
    const files = Array.from({ length: 60 }, (_, i) => `M\tbig/f${i}.txt`).join("\n");
    const log = `${SHA_A}\n${files}\n\n${SHA_B}\nM\tsrc/auth.ts\nM\tsrc/middleware.ts\n`;
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toEqual([{ a: "src/auth.ts", b: "src/middleware.ts", count: 1 }]);
  });

  it("sorts pair endpoints so (a, b) and (b, a) collapse", () => {
    const log = `${SHA_A}\nM\tz.ts\nM\ta.ts\n`;
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs[0]).toEqual({ a: "a.ts", b: "z.ts", count: 1 });
  });

  it("skips commits with fewer than 2 files (no pair possible)", () => {
    const log = `${SHA_A}\nM\tonly.ts\n\n${SHA_B}\nM\ta.ts\nM\tb.ts\n`;
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toEqual([{ a: "a.ts", b: "b.ts", count: 1 }]);
  });

  it("does not mis-detect hex-only filenames as SHA lines", () => {
    const log = `${SHA_A}\nM\tassets/cafe.png\nM\tassets/deadbeef.bin\nM\tsrc/loader.ts\n`;
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toHaveLength(3);
    const files = new Set(pairs.flatMap((p) => [p.a, p.b]));
    expect(files).toEqual(new Set([
      "assets/cafe.png", "assets/deadbeef.bin", "src/loader.ts",
    ]));
  });

  it("handles A/M/D status prefixes uniformly", () => {
    const log = `${SHA_A}\nA\tnew.ts\nM\tmodified.ts\nD\tdeleted.ts\n`;
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    // 3 files × C(3,2) = 3 pairs.
    expect(pairs).toHaveLength(3);
    const files = new Set(pairs.flatMap((p) => [p.a, p.b]));
    expect(files).toEqual(new Set(["new.ts", "modified.ts", "deleted.ts"]));
  });
});

describe("parseCoChangeLog — rename resolution", () => {
  it("aliases the historical name to the current name (commits walked newest-first)", () => {
    // Newest commit references the new name; rename commit emits R; oldest
    // references the old name. After resolution, all three should attribute
    // to the new name.
    const log =
      `${SHA_A}\n` +                        // newest
      "M\tlib/a.ts\n" +
      "M\tpartner.ts\n" +
      "\n" +
      `${SHA_B}\n` +                        // rename commit
      "R100\tsrc/a.ts\tlib/a.ts\n" +
      "M\tpartner.ts\n" +
      "\n" +
      `${SHA_C}\n` +                        // oldest, pre-rename
      "A\tsrc/a.ts\n" +
      "A\tpartner.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    // 3 commits × 1 pair each → all three are (lib/a.ts, partner.ts).
    expect(pairs).toHaveLength(3);
    for (const p of pairs) {
      expect(p).toEqual({ a: "lib/a.ts", b: "partner.ts", count: 1 });
    }
  });

  it("chains transitive renames a → b → c", () => {
    // Newest commit references c; middle renames b → c; older renames a → b;
    // oldest creates a.  After resolution every reference resolves to c.
    const log =
      `${SHA_A}\n` +
      "M\tc.ts\n" +
      "M\tpartner.ts\n" +
      "\n" +
      `${SHA_B}\n` +
      "R100\tb.ts\tc.ts\n" +
      "M\tpartner.ts\n" +
      "\n" +
      `${SHA_C}\n` +
      "R100\ta.ts\tb.ts\n" +
      "M\tpartner.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toHaveLength(3);
    for (const p of pairs) {
      expect(p).toEqual({ a: "c.ts", b: "partner.ts", count: 1 });
    }
  });

  it("does NOT alias a path that's reused for a new file after rename", () => {
    // C1 (newest): a.ts (a NEW file created at the old name post-rename),
    //              partner.ts
    // C2          : rename old.ts → b.ts AND modify partner.ts
    // C3 (oldest) : old.ts + partner.ts created
    //
    // After resolution:
    //   - C1's a.ts is a distinct file (the new one). No alias.
    //   - C2 produces pair (b.ts, partner.ts).
    //   - C3's old.ts resolves to b.ts via the alias registered in C2.
    const log =
      `${SHA_A}\n` +
      "A\ta.ts\n" +
      "M\tpartner.ts\n" +
      "\n" +
      `${SHA_B}\n` +
      "R100\told.ts\tb.ts\n" +
      "M\tpartner.ts\n" +
      "\n" +
      `${SHA_C}\n` +
      "A\told.ts\n" +
      "A\tpartner.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toHaveLength(3);
    // C1: (a.ts, partner.ts)
    expect(pairs[0]).toEqual({ a: "a.ts", b: "partner.ts", count: 1 });
    // C2: (b.ts, partner.ts) — rename emits the new name
    expect(pairs[1]).toEqual({ a: "b.ts", b: "partner.ts", count: 1 });
    // C3: (b.ts, partner.ts) — old.ts resolves via alias
    expect(pairs[2]).toEqual({ a: "b.ts", b: "partner.ts", count: 1 });
  });
});

describe("collectCoChange (integration over git log)", () => {
  it("aggregates pairs across commits and applies min_count filter", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 1,
    });
    // auth ↔ middleware appears in 2 commits → count 2
    // auth ↔ api appears in 1 commit → count 1
    const am = pairs.find((p) => p.a === "src/auth.ts" && p.b === "src/middleware.ts");
    const aa = pairs.find((p) => p.a === "src/api.ts" && p.b === "src/auth.ts");
    expect(am?.count).toBe(2);
    expect(aa?.count).toBe(1);
  });

  it("drops the 60-file format-pass commit", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 1,
    });
    // No pair containing big/f*.txt should appear.
    expect(pairs.some((p) => p.a.startsWith("big/") || p.b.startsWith("big/"))).toBe(false);
  });

  it("min_count filter removes singletons", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 2,
    });
    // Only the auth↔middleware pair has count >= 2.
    expect(pairs).toEqual([
      { a: "src/auth.ts", b: "src/middleware.ts", count: 2 },
    ]);
  });

  it("returns pairs sorted desc by count", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 1,
    });
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]!.count).toBeGreaterThanOrEqual(pairs[i]!.count);
    }
  });
});

describe("collectCoChange — rename detection against a real git repo", () => {
  it("attributes pre-rename commits to the current path", () => {
    // Fixture: src/a.ts created with partner; then renamed to lib/a.ts +
    // partner edit; then both edited. Without rename resolution the matrix
    // would split (src/a.ts, partner.ts) and (lib/a.ts, partner.ts). With
    // resolution they should aggregate under the current path lib/a.ts.
    const pairs = collectCoChange({
      repo_path: renameRoot,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 1,
    });
    // No pair should still mention src/a.ts (the historical path).
    expect(pairs.some((p) => p.a === "src/a.ts" || p.b === "src/a.ts")).toBe(false);
    // (lib/a.ts, src/partner.ts) should be present with count 3 (init,
    // rename, edit-renamed — all three touched both files).
    const found = pairs.find(
      (p) =>
        (p.a === "lib/a.ts" && p.b === "src/partner.ts") ||
        (p.a === "src/partner.ts" && p.b === "lib/a.ts"),
    );
    expect(found?.count).toBe(3);
  });
});
