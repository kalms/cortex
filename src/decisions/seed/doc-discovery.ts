import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DecisionCandidate } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".cortex", "dist", "build", ".tmp", ".playwright-mcp"]);
const ADR_PATH = /(^|\/)(adr|decisions)(\/|$)/i;
const ADR_FILE = /(^|\/)(adr-|\d{4}-).+\.md$/i;
const DOC_ROOT = /(^|\/)docs(\/|$)/i;
// One ADR heading is enough — prefer recall over precision; the seed skill re-evaluates.
const ADR_HEADINGS = /^##\s+(context|decision|consequences)\b/im;
const EXCERPT_CHARS = 1500;

/** Recursively collect *.md paths, skipping vendored/derived dirs. */
function walkMarkdown(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently
  }
  for (const entry of entries) {
    // Skip all dot-prefixed entries (.git, .github, .vscode, .husky, etc).
    // Hidden dirs in a repo almost never contain decision docs; PR templates
    // matching ADR headings are a known false-positive source.
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkMarkdown(root, abs, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(abs);
    }
  }
}

/**
 * Discover documentation-derived decision candidates. ADR-shaped docs (by path
 * or by Context/Decision/Consequences headings) are high confidence; other
 * docs under a docs/ tree are medium-confidence prose. Top-level READMEs and
 * non-doc markdown are ignored — they are rarely decision records.
 */
export function discoverDocCandidates(
  repoPath: string,
  onlyPaths?: ReadonlySet<string>,
): DecisionCandidate[] {
  const files: string[] = [];
  walkMarkdown(repoPath, repoPath, files);
  const candidates: DecisionCandidate[] = [];

  for (const abs of files) {
    const rel = relative(repoPath, abs).split(sep).join("/");
    // Warm path (base set): only docs touched in the scoped diff qualify.
    if (onlyPaths && !onlyPaths.has(rel)) continue;
    let body = "";
    try {
      if (statSync(abs).size > 512 * 1024) continue; // skip huge generated docs
      body = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }

    const isAdrPath = ADR_PATH.test(rel) || ADR_FILE.test(rel);
    const isAdrShaped = ADR_HEADINGS.test(body);
    const isDoc = DOC_ROOT.test(rel);

    if (isAdrPath || isAdrShaped) {
      candidates.push({
        kind: "adr",
        confidence: "high",
        title_hint: firstHeading(body) ?? rel,
        provenance: { doc_path: rel, files_touched: [] },
        raw_excerpt: body.slice(0, EXCERPT_CHARS),
      });
    } else if (isDoc) {
      candidates.push({
        kind: "prose",
        confidence: "medium",
        title_hint: firstHeading(body) ?? rel,
        provenance: { doc_path: rel, files_touched: [] },
        raw_excerpt: body.slice(0, EXCERPT_CHARS),
      });
    }
  }
  return candidates;
}

function firstHeading(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}
