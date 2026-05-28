import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Direct path to tsx — faster than `npx tsx` and avoids PATH dependency.
const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

describe("cortex decision candidates", () => {
  it("prints a JSON manifest framed from docs + commits", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-cand-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    writeFileSync(join(root, "docs/adr/0001-x.md"), "# X\n## Context\na\n## Decision\nb\n");
    try {
      const out = execFileSync(TSX, [CLI, "decision", "candidates", "--format=json"], {
        cwd: root, encoding: "utf-8",
      });
      const manifest = JSON.parse(out);
      expect(Array.isArray(manifest)).toBe(true);
      expect(manifest.some((c: any) => c.provenance.doc_path === "docs/adr/0001-x.md")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("finds docs/adr from a subdirectory invocation", () => {
    // ctx.gitRoot must be used instead of ctx.cwd; otherwise the walker
    // misses ADRs that live above the invocation dir.
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-cand-sub-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    writeFileSync(join(root, "docs/adr/0001-x.md"), "# X\n## Context\na\n## Decision\nb\n");
    const sub = join(root, "deep/nested/sub");
    mkdirSync(sub, { recursive: true });
    try {
      const out = execFileSync(TSX, [CLI, "decision", "candidates"], {
        cwd: sub, encoding: "utf-8",
      });
      const manifest = JSON.parse(out);
      expect(manifest.some((c: any) => c.provenance.doc_path === "docs/adr/0001-x.md")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects --max=abc with a UsageError exit", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-cli-cand-nan-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    try {
      // execFileSync throws on non-zero exit; capture and inspect stderr.
      let stderr = "";
      try {
        execFileSync(TSX, [CLI, "decision", "candidates", "--max=abc"], {
          cwd: root, encoding: "utf-8", stdio: "pipe",
        });
      } catch (e: any) {
        stderr = String(e.stderr ?? "");
      }
      expect(stderr).toMatch(/--max must be a positive integer/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
