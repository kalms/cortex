import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDocCandidates } from "../../../src/decisions/seed/doc-discovery.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-docs-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("discoverDocCandidates", () => {
  it("classifies an ADR-pathed file as high-confidence adr", () => {
    const root = repoWith({ "docs/adr/0007-use-sqlite.md": "# Use SQLite\n## Context\nx\n## Decision\ny\n" });
    try {
      const cands = discoverDocCandidates(root);
      expect(cands).toHaveLength(1);
      expect(cands[0].kind).toBe("adr");
      expect(cands[0].confidence).toBe("high");
      expect(cands[0].provenance.doc_path).toBe("docs/adr/0007-use-sqlite.md");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("classifies a doc with ADR-shaped headings as adr even outside an adr/ dir", () => {
    const root = repoWith({ "notes/choice.md": "# Choice\n## Context\na\n## Decision\nb\n## Consequences\nc\n" });
    try {
      const cands = discoverDocCandidates(root);
      expect(cands.map((c) => c.kind)).toContain("adr");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("classifies docs/architecture prose as medium-confidence prose", () => {
    const root = repoWith({ "docs/architecture/graph-ui.md": "# Graph UI\nLong design narrative without ADR headings.\n" });
    try {
      const cands = discoverDocCandidates(root);
      expect(cands).toHaveLength(1);
      expect(cands[0].kind).toBe("prose");
      expect(cands[0].confidence).toBe("medium");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores non-doc dirs (node_modules, .git, .cortex)", () => {
    const root = repoWith({
      "node_modules/pkg/readme.md": "## Context\n## Decision\n",
      ".git/x.md": "## Decision\n",
      "README.md": "# Top-level readme, not a decision doc\n",
    });
    try {
      expect(discoverDocCandidates(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("skips markdown files larger than 512 KB", () => {
    const big = "x".repeat(513 * 1024);
    const root = repoWith({ "docs/architecture/huge.md": big });
    try {
      // Even though it's under docs/, the size cap excludes it.
      expect(discoverDocCandidates(root)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
