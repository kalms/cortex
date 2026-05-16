// tests/frame-extraction/fs-stats.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFsStats } from "../../scripts/frame-extraction/fs-stats.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-fs-stats-"));
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  mkdirSync(join(root, "src", "billing", "internal"), { recursive: true });
  mkdirSync(join(root, "locales"), { recursive: true });
  mkdirSync(join(root, "__snapshots__"), { recursive: true });
  // Nested-aux case: aux pattern is NOT a top-level segment. The flagged
  // name should be the matching segment ("fixtures"), not segments[0] ("src").
  mkdirSync(join(root, "src", "components", "fixtures"), { recursive: true });
  writeFileSync(join(root, "src", "components", "fixtures", "sample.json"), "{}\n");
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
  writeFileSync(join(root, "src", "auth", "auth.ts"), "export {};\n");
  writeFileSync(join(root, "src", "billing", "internal", "deep.ts"), "export {};\n");
  writeFileSync(join(root, "locales", "en.json"), "{}\n");
  writeFileSync(join(root, "locales", "de.json"), "{}\n");
  writeFileSync(join(root, "__snapshots__", "x.snap"), "");
  writeFileSync(join(root, "README.md"), "# x\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("collectFsStats", () => {
  it("counts files excluding .git and node_modules", () => {
    const stats = collectFsStats(root);
    // 3 .ts + 3 .json + 1 .md + 1 .snap = 8
    expect(stats.file_count).toBe(8);
  });

  it("computes depth as path segments under the repo root", () => {
    const stats = collectFsStats(root);
    // src/billing/internal/deep.ts → depth=3 ; src/components/fixtures/sample.json → depth=3
    expect(stats.max_depth).toBe(3);
    expect(stats.mean_depth).toBeGreaterThan(0);
    expect(stats.mean_depth).toBeLessThanOrEqual(stats.max_depth);
  });

  it("builds an extension histogram with leading dots and lowercased keys", () => {
    const stats = collectFsStats(root);
    expect(stats.extension_histogram[".ts"]).toBe(3);
    expect(stats.extension_histogram[".json"]).toBe(3);
    expect(stats.extension_histogram[".md"]).toBe(1);
  });

  it("flags auxiliary directories from the path-pattern list, including nested matches", () => {
    const stats = collectFsStats(root);
    // Top-level "locales" + "__snapshots__" + nested "fixtures" (under src/components/).
    // The nested case must report "fixtures", not segments[0] ("src").
    expect(stats.auxiliary_directories).toEqual(["__snapshots__", "fixtures", "locales"]);
  });
});
