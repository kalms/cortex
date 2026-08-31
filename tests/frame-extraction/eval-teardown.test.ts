// tests/frame-extraction/eval-teardown.test.ts
import { describe, it, expect } from "vitest";
import { teardownTargets } from "../../scripts/frame-extraction/eval-all.js";
import type { RepoSpec } from "../../src/frame-extraction/types.js";

const repos: RepoSpec[] = [
  { slug: "self/cortex", git: null, local_path: ".", archetype: "x", size_hint: "medium", primary_language: "typescript" },
  { slug: "local/private-monorepo", git: null, local_path: "/p", archetype: "x", size_hint: "medium", primary_language: "typescript" },
  { slug: "vercel/commerce", git: "https://github.com/vercel/commerce.git", archetype: "x", size_hint: "medium", primary_language: "typescript" },
  { slug: "saleor/saleor", git: "https://example/saleor.git", archetype: "x", size_hint: "medium", primary_language: "python" },
];

describe("teardownTargets", () => {
  it("returns only git-cloned corpus projects that resolved a project name", () => {
    const rows = [
      { slug: "self/cortex", ok: true, project: "Users-rka-Development-cortex" },
      { slug: "local/private-monorepo", ok: true, project: "Users-rka-Development-private-monorepo" },
      { slug: "vercel/commerce", ok: true, project: "p-commerce" },
      { slug: "saleor/saleor", ok: true, project: "p-saleor" },
    ];
    expect(teardownTargets(repos, rows)).toEqual(["p-commerce", "p-saleor"]);
  });

  it("excludes local_path fixtures even when they carry a project name", () => {
    const rows = [
      { slug: "self/cortex", ok: true, project: "Users-rka-Development-cortex" },
      { slug: "local/private-monorepo", ok: true, project: "Users-rka-Development-private-monorepo" },
    ];
    expect(teardownTargets(repos, rows)).toEqual([]);
  });

  it("skips cloned repos that failed to index (no project name)", () => {
    const rows = [
      { slug: "vercel/commerce", ok: false, error: "clone failed" },
      { slug: "saleor/saleor", ok: true, project: "p-saleor" },
    ];
    expect(teardownTargets(repos, rows)).toEqual(["p-saleor"]);
  });

  it("returns empty when no cloned repos ran", () => {
    const rows = [{ slug: "self/cortex", ok: true, project: "Users-rka-Development-cortex" }];
    expect(teardownTargets(repos, rows)).toEqual([]);
  });
});
