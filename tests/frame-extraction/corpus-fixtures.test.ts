import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CorpusFile } from "../../src/frame-extraction/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, "../../scripts/frame-extraction/corpus.json"), "utf-8"),
) as CorpusFile;

describe("corpus framework fixtures", () => {
  it("includes the new framework archetypes", () => {
    const archetypes = new Set(corpus.repos.map((r) => r.archetype));
    expect(archetypes).toContain("next-app");
    expect(archetypes).toContain("django-app");
    expect(archetypes).toContain("rails-app");
  });
  it("every repo is well-formed (git xor local_path)", () => {
    for (const r of corpus.repos) {
      expect(typeof r.slug).toBe("string");
      const hasGit = typeof r.git === "string" && r.git.length > 0;
      const hasLocal = typeof r.local_path === "string" && r.local_path.length > 0;
      expect(hasGit || hasLocal).toBe(true);
    }
  });
  it("self/cortex is a local-only fixture", () => {
    const a = corpus.repos.find((r) => r.slug === "self/cortex");
    expect(a).toBeDefined();
    expect(a!.git).toBeNull();
    expect(a!.local_path).toBeTruthy();
  });
});
