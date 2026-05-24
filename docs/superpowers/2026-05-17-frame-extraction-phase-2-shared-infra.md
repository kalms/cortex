# Frame Extraction — Phase 2 Shared Infrastructure Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared infrastructure that all three Phase 2 clustering candidates (Leiden, TF-IDF + HDBSCAN, pinned-embedding + HDBSCAN) and the eval harness will consume: framework-aware path tokenizer, git-log co-change matrix, and the 5-archetype Phase 2 corpus definition.

**Architecture:**

- All TS. No Python yet — that comes in subsequent algorithm-candidate plans.
- Pure-function modules under `scripts/frame-extraction/` (alongside Phase 1's clone/indexer/graph-stats/fs-stats). Each module gets its own vitest spec.
- Output of co-change is a JSONL file (one line per file-pair, fields `a`, `b`, `count`), written to `.tmp/frame-extraction/co-change/<repo-slug>.jsonl`. JSONL avoids loading the whole matrix into memory when downstream consumers stream pairs.
- Corpus definition follows the same shape as Phase 1's `corpus.json` (versioned schema + `repos[]`), so the existing `clone.ts` wrapper is reusable.

**Tech Stack:**

- Node built-ins only (`node:child_process`, `node:fs`, `node:path`). No new npm deps.
- vitest for tests.
- `git log` for the co-change source.

---

## Scope Check

This plan covers three independent-but-related deliverables (corpus, tokenizer, co-change). They're related because they're all consumed by the same downstream — Phase 2 algorithms — but each is independently testable and could ship alone. Bundling them in one plan because:

1. Each is small enough that splitting would be churn (no single one warrants its own PR).
2. They form a coherent "shared infra layer" that any algorithm candidate can be implemented against without further dependencies.
3. Reviewers benefit from seeing the layer together rather than as three drips.

If any one balloons during implementation, split it out.

---

## File Structure

**New files:**

- `scripts/frame-extraction/phase2-corpus.json` — 5-archetype corpus (Nuxt, React SPA, Go service, Python ML, TS monorepo).
- `scripts/frame-extraction/path-tokenize.ts` — framework-aware tokenizer (strip universal/frontend/backend/test segments + role suffixes; tokenize remaining basename + symbol names into a Set<string>).
- `scripts/frame-extraction/co-change.ts` — read `git log --name-only --pretty=format:%H --since=180.days.ago --no-renames -M`, drop ≥50-file commits, accumulate file-pair counts, write JSONL.
- `tests/frame-extraction/path-tokenize.test.ts` — pure-function tests.
- `tests/frame-extraction/co-change.test.ts` — fixture-driven tests using a synthetic git repo.

**Modified files:**

- `scripts/frame-extraction/types.ts` — extend with `FilePair`, `CoChangeOptions`, and (no extension needed for the tokenizer — its function signature is self-contained).
- `package.json` — add a single npm script `"co-change": "tsx scripts/frame-extraction/co-change.ts"` for ad-hoc runs against any repo path.

No existing TS code is rewritten. The corpus + tokenizer + co-change all sit alongside Phase 1's modules.

---

## Task 1: Phase 2 corpus selection

**Files:**
- Create: `scripts/frame-extraction/phase2-corpus.json`

- [ ] **Step 1: Write the corpus file**

The Phase 2 spec (`docs/specs/cortex-v0.3/frame-extraction.md` §Verification §Phase 2) asks for 5 specific archetypes. Picks below are sized to keep total runtime tractable (each repo ≤ ~30k entities) and chosen to span size, language, and architectural style.

```json
{
  "$schema_version": 1,
  "comment": "Phase 2 algorithm-selection corpus. One repo per archetype from frame-extraction.md §Verification §Phase 2. Picked to span size, language, and architectural style while keeping per-repo indexing + clustering tractable on a laptop.",
  "repos": [
    {
      "slug": "nuxt/ui",
      "git": "https://github.com/nuxt/ui.git",
      "archetype": "nuxt-app",
      "size_hint": "medium",
      "primary_language": "typescript"
    },
    {
      "slug": "excalidraw/excalidraw",
      "git": "https://github.com/excalidraw/excalidraw.git",
      "archetype": "react-spa",
      "size_hint": "medium",
      "primary_language": "typescript"
    },
    {
      "slug": "caddyserver/caddy",
      "git": "https://github.com/caddyserver/caddy.git",
      "archetype": "go-service",
      "size_hint": "medium",
      "primary_language": "go"
    },
    {
      "slug": "huggingface/peft",
      "git": "https://github.com/huggingface/peft.git",
      "archetype": "python-ml",
      "size_hint": "medium",
      "primary_language": "python"
    },
    {
      "slug": "trpc/trpc",
      "git": "https://github.com/trpc/trpc.git",
      "archetype": "ts-monorepo",
      "size_hint": "medium",
      "primary_language": "typescript"
    }
  ]
}
```

- [ ] **Step 2: Validate the JSON parses**

Run:
```bash
python3 -c "import json; json.load(open('scripts/frame-extraction/phase2-corpus.json'))"
```
Expected: no output (clean parse).

- [ ] **Step 3: Verify the existing CorpusFile type accepts it**

The `RepoSpec` + `CorpusFile` types in `scripts/frame-extraction/types.ts` were defined for Phase 1's `corpus.json`. The Phase 2 file uses the same shape — verify by importing it from a one-line tsx invocation:

```bash
npx tsx -e 'import("./scripts/frame-extraction/types.js").then(async () => { const f = JSON.parse(require("node:fs").readFileSync("scripts/frame-extraction/phase2-corpus.json","utf-8")); console.log(`repos: ${f.repos.length}`); console.log(f.repos.map(r => r.archetype).join(", ")); })'
```

Expected output:
```
repos: 5
nuxt-app, react-spa, go-service, python-ml, ts-monorepo
```

- [ ] **Step 4: Commit**

```bash
git add scripts/frame-extraction/phase2-corpus.json
git commit -m "feat(frame-extraction): seed Phase 2 5-archetype corpus"
```

---

## Task 2: Path tokenizer types

**Files:**
- Modify: `scripts/frame-extraction/types.ts` (add `PathTokenizeOptions`, `PathTokens`)

- [ ] **Step 1: Add the types**

Open `scripts/frame-extraction/types.ts` and append below the existing types (after `SurveyResult`):

```ts
/** Options controlling framework-aware path tokenization.
 *  Defaults are baked into `tokenizePath`; callers override only when
 *  exercising the service-suffix edge case (see frame-extraction.md
 *  §Path tokenization). */
export interface PathTokenizeOptions {
  /** Strip role suffixes only when the prefix is itself a domain token
   *  (i.e. not a member of `STRIP_SEGMENTS`). Defaults to true. */
  service_suffix_aware: boolean;
}

/** Output of tokenizing a file path. `path_tokens` come from the stripped
 *  path; `symbol_tokens` come from the bare filename (after extension
 *  removal). Returned as ordered sets (string[]) so callers can compute
 *  Jaccard, cosine, etc. without re-sorting. */
export interface PathTokens {
  path_tokens: string[];
  symbol_tokens: string[];
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no output (clean compile). The existing project tsconfig includes `scripts/` already; if it doesn't, that's a separate issue — flag and stop.

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/types.ts
git commit -m "feat(frame-extraction): add PathTokens types for the tokenizer"
```

---

## Task 3: Path tokenizer implementation + tests

**Files:**
- Create: `scripts/frame-extraction/path-tokenize.ts`
- Create: `tests/frame-extraction/path-tokenize.test.ts`

The tokenizer's job is to take a file path and return two ordered token sets: `path_tokens` (from the directory structure after stripping conventional segments) and `symbol_tokens` (from the bare filename after extension + role-suffix stripping). It's used both by Leiden (as an edge-weight component via Jaccard) and by the TF-IDF/embedding pipelines (as part of the per-file text blob).

The strip list comes verbatim from `frame-extraction.md` §Path tokenization (framework-aware).

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/path-tokenize.test.ts
import { describe, it, expect } from "vitest";
import { tokenizePath } from "../../scripts/frame-extraction/path-tokenize.js";

describe("tokenizePath — universal/frontend/backend segments are stripped", () => {
  it("strips src + app + components", () => {
    const { path_tokens } = tokenizePath("src/app/components/billing/invoice.ts");
    expect(path_tokens).toEqual(["billing"]);
  });

  it("strips multiple consecutive convention segments", () => {
    const { path_tokens } = tokenizePath("src/lib/services/auth/middleware/token.ts");
    expect(path_tokens).toEqual(["auth", "middleware", "token"]);
  });

  it("does NOT strip non-convention segments", () => {
    const { path_tokens } = tokenizePath("packages/core/billing/invoice.ts");
    expect(path_tokens).toEqual(["packages", "core", "billing", "invoice"]);
  });

  it("retains case but lowercases for consistency", () => {
    const { path_tokens } = tokenizePath("src/app/Billing/InvoiceList.tsx");
    expect(path_tokens).toEqual(["billing"]);
  });
});

describe("tokenizePath — role suffixes", () => {
  it("strips role suffix when the prefix is NOT a domain token (default)", () => {
    // `auth.service.ts` → suffix `.service` stripped because `auth` is a
    // perfectly fine domain word; the role tag is noise here.
    const { symbol_tokens } = tokenizePath("src/auth/auth.service.ts");
    expect(symbol_tokens).toEqual(["auth"]);
  });

  it("preserves role suffix when the prefix IS itself a convention/strip token", () => {
    // `service.service.ts` is pathological but reveals the intent: if the
    // prefix would be stripped, the suffix is the only thing carrying signal.
    const { symbol_tokens } = tokenizePath("packages/foo/service.service.ts", {
      service_suffix_aware: true,
    });
    // After stripping the prefix-as-convention, only `service` would remain
    // before suffix stripping. Suffix-aware mode keeps it as `service`.
    expect(symbol_tokens).toEqual(["service"]);
  });

  it("strips .test and .spec uniformly", () => {
    expect(tokenizePath("src/billing/invoice.test.ts").symbol_tokens).toEqual(["invoice"]);
    expect(tokenizePath("src/billing/invoice.spec.ts").symbol_tokens).toEqual(["invoice"]);
  });

  it("handles paths with no extension", () => {
    const { symbol_tokens } = tokenizePath("Makefile");
    expect(symbol_tokens).toEqual(["makefile"]);
  });
});

describe("tokenizePath — camel/snake/kebab splitting", () => {
  it("splits camelCase into separate symbol tokens", () => {
    expect(tokenizePath("src/InvoiceList.tsx").symbol_tokens).toEqual(["invoice", "list"]);
  });

  it("splits snake_case", () => {
    expect(tokenizePath("src/auth/refresh_token.py").symbol_tokens).toEqual(["refresh", "token"]);
  });

  it("splits kebab-case", () => {
    expect(tokenizePath("src/use-billing-state.ts").symbol_tokens).toEqual(["use", "billing", "state"]);
  });

  it("deduplicates within each token list (preserves first occurrence order)", () => {
    const { path_tokens } = tokenizePath("billing/billing/invoice.ts");
    expect(path_tokens).toEqual(["billing", "invoice"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/frame-extraction/path-tokenize.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module './path-tokenize.js'`.

- [ ] **Step 3: Implement the tokenizer**

```ts
// scripts/frame-extraction/path-tokenize.ts
import { basename, dirname, extname, sep } from "node:path";
import type { PathTokenizeOptions, PathTokens } from "./types.js";

/**
 * Conventional path segments stripped before extracting domain tokens.
 * Source: docs/specs/cortex-v0.3/frame-extraction.md §Path tokenization.
 * Order doesn't matter; this is a set lookup.
 */
const STRIP_SEGMENTS = new Set([
  // Universal
  "src", "lib",
  // Frontend conventions
  "app", "pages", "components", "composables", "layouts", "middleware",
  "plugins", "stores", "views", "router",
  // Backend conventions
  "cmd", "internal", "pkg", "api", "controllers", "services", "models", "routes",
  // Test/build conventions
  "tests", "test", "__tests__", "spec", "docs", "dist", "build",
]);

/**
 * Role suffixes stripped from filenames (after extension removal).
 * The dot is part of the suffix in the source name (`auth.service.ts`).
 * Stored without the dot for set lookup against split parts.
 */
const ROLE_SUFFIXES = new Set([
  "service", "helper", "controller", "repository", "test", "spec",
]);

const DEFAULT_OPTS: PathTokenizeOptions = {
  service_suffix_aware: true,
};

/** Split an identifier into lowercase word parts, handling camelCase,
 *  snake_case, kebab-case, and dotted (`foo.bar`) names uniformly. */
function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._\-/]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

function dedupePreserveOrder(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/** Strip extension AND role-suffix from a bare filename, returning the
 *  remaining stem. `auth.service.ts` → `auth`; `invoice.test.tsx` →
 *  `invoice`. If `service_suffix_aware` is true and the stem-without-suffix
 *  is itself a STRIP_SEGMENTS member, restore the suffix so we don't lose
 *  the only domain signal. */
function stripFilename(filename: string, opts: PathTokenizeOptions): string {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  // Find the last dotted segment — that's the role candidate.
  const lastDot = stem.lastIndexOf(".");
  if (lastDot === -1) return stem;
  const candidate = stem.slice(lastDot + 1).toLowerCase();
  if (!ROLE_SUFFIXES.has(candidate)) return stem;
  const prefix = stem.slice(0, lastDot);
  if (opts.service_suffix_aware) {
    // If the prefix is itself a STRIP_SEGMENTS token, the suffix is the
    // only domain signal — keep it.
    const prefixWords = splitWords(prefix);
    const prefixIsAllStrip =
      prefixWords.length > 0 &&
      prefixWords.every((w) => STRIP_SEGMENTS.has(w));
    if (prefixIsAllStrip) return candidate;
  }
  return prefix;
}

export function tokenizePath(
  filePath: string,
  opts: Partial<PathTokenizeOptions> = {},
): PathTokens {
  const merged = { ...DEFAULT_OPTS, ...opts };
  const file = basename(filePath);
  const dir = dirname(filePath);

  // Path tokens: split the directory by separator, lowercase, drop strip-list.
  const dirSegments = dir
    .split(sep)
    .map((s) => s.toLowerCase())
    .filter((s) => s !== "" && s !== "." && !STRIP_SEGMENTS.has(s));

  // Also tokenize the filename stem into path_tokens (the basename carries
  // domain information just like its parent dirs). Strip role suffix first.
  const stem = stripFilename(file, merged);
  const stemWords = splitWords(stem).filter((w) => !STRIP_SEGMENTS.has(w));
  const allPath = [...dirSegments.flatMap(splitWords), ...stemWords];

  // Symbol tokens: only the stripped stem, split into words.
  return {
    path_tokens: dedupePreserveOrder(allPath),
    symbol_tokens: dedupePreserveOrder(stemWords),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/frame-extraction/path-tokenize.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/path-tokenize.ts tests/frame-extraction/path-tokenize.test.ts
git commit -m "feat(frame-extraction): framework-aware path tokenizer"
```

---

## Task 4: Co-change types

**Files:**
- Modify: `scripts/frame-extraction/types.ts`

- [ ] **Step 1: Add the types**

Append below the `PathTokens` types from Task 2:

```ts
/** A single co-change observation: files `a` and `b` appeared together in
 *  `count` commits over the analysis window. Stored sorted by `a < b` to
 *  avoid double-counting symmetric pairs. */
export interface FilePair {
  a: string;
  b: string;
  count: number;
}

export interface CoChangeOptions {
  /** Repo to analyse. */
  repo_path: string;
  /** Co-change window. The spec uses 180 days from HEAD's committer date. */
  since_days: number;
  /** Drop commits with this many or more files (format passes, bulk renames,
   *  initial imports). Spec starter: 50. */
  big_commit_threshold: number;
  /** Drop pairs with `count` below this. Defaults to 2 so single co-occurrences
   *  don't dominate downstream noise. */
  min_count: number;
}

export type FilePairStream = AsyncIterable<FilePair> | Iterable<FilePair>;
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/types.ts
git commit -m "feat(frame-extraction): add FilePair + CoChangeOptions types"
```

---

## Task 5: Co-change implementation + tests

**Files:**
- Create: `scripts/frame-extraction/co-change.ts`
- Create: `tests/frame-extraction/co-change.test.ts`

The co-change module reads `git log --name-only --pretty=format:%H --since=<N>.days.ago` over a repo, accumulates `(file_a, file_b) → count` over all commits below the big-commit threshold, and emits `FilePair[]` sorted descending by count.

Rename tracking matters: when `git log -M` detects a rename, the new name is used for ALL touches of that file (including pre-rename history). Git resolves this automatically with `-M` enabled. The spec asks for "renames detected via git's -M so a recently-renamed file keeps its history."

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/co-change.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { collectCoChange, parseCoChangeLog } from "../../scripts/frame-extraction/co-change.js";

let root: string;

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
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseCoChangeLog (pure)", () => {
  it("yields one pair per file-pair per commit", () => {
    const log =
      "abc123\n" +
      "src/auth.ts\n" +
      "src/middleware.ts\n" +
      "\n" +
      "def456\n" +
      "src/auth.ts\n" +
      "src/middleware.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    // 2 commits × 1 pair each = 2 raw pair events. parseCoChangeLog yields
    // the raw events; aggregation is collectCoChange's job.
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ a: "src/auth.ts", b: "src/middleware.ts", count: 1 });
    expect(pairs[1]).toEqual({ a: "src/auth.ts", b: "src/middleware.ts", count: 1 });
  });

  it("drops commits with >= big_commit_threshold files", () => {
    const files = Array.from({ length: 60 }, (_, i) => `big/f${i}.txt`).join("\n");
    const log = `abc123\n${files}\n\ndef456\nsrc/auth.ts\nsrc/middleware.ts\n`;
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    // Only the small commit's pair survives.
    expect(pairs).toEqual([{ a: "src/auth.ts", b: "src/middleware.ts", count: 1 }]);
  });

  it("sorts pair endpoints so (a, b) and (b, a) collapse", () => {
    const log = "abc123\nz.ts\na.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs[0]).toEqual({ a: "a.ts", b: "z.ts", count: 1 });
  });

  it("skips commits with fewer than 2 files (no pair possible)", () => {
    const log = "abc123\nonly.ts\n\ndef456\na.ts\nb.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toEqual([{ a: "a.ts", b: "b.ts", count: 1 }]);
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/frame-extraction/co-change.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the co-change module**

```ts
// scripts/frame-extraction/co-change.ts
/**
 * Co-change matrix from git log. See docs/specs/cortex-v0.3/frame-extraction.md
 * §Co-change as semantic signal. Read 180-day default window, drop
 * big-commit format passes, count file-pair co-occurrences.
 *
 * CLI usage:
 *   tsx scripts/frame-extraction/co-change.ts <repo-path> [--out <path>]
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CoChangeOptions, FilePair } from "./types.js";

interface ParseOptions {
  big_commit_threshold: number;
}

/** Stream individual `FilePair` events from a `git log` block. Each event
 *  has `count: 1`; the caller aggregates. Pair endpoints are sorted so
 *  `(b, a)` collapses to `(a, b)`. Pure function — fully testable. */
export function* parseCoChangeLog(
  log: string,
  opts: ParseOptions,
): Iterable<FilePair> {
  // Format: each commit is a line with the SHA, followed by N lines of
  // touched paths, followed by a blank line. (`--pretty=format:%H` does
  // not emit a trailing newline, so the last commit has no terminator.)
  const lines = log.split("\n");
  let files: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      // Commit boundary.
      yield* pairsForCommit(files, opts);
      files = [];
      i += 1;
      continue;
    }
    // A SHA line is 40 hex chars. Anything else is a file path. We treat
    // the FIRST non-empty line after a blank (or start-of-input) as the
    // SHA; subsequent non-empty lines are paths.
    if (files.length === 0 && /^[0-9a-f]{7,40}$/.test(line)) {
      // SHA line — discard, we don't need it.
      i += 1;
      continue;
    }
    files.push(line);
    i += 1;
  }
  // Flush trailing commit.
  if (files.length > 0) yield* pairsForCommit(files, opts);
}

function* pairsForCommit(
  files: string[],
  opts: ParseOptions,
): Iterable<FilePair> {
  if (files.length < 2 || files.length >= opts.big_commit_threshold) return;
  // Dedupe within a commit (in case the same path appears twice for any
  // reason) and sort for stable iteration.
  const unique = Array.from(new Set(files)).sort();
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i]!;
      const b = unique[j]!;
      // Endpoints already in sorted order from the outer sort.
      yield { a, b, count: 1 };
    }
  }
}

/** Run `git log` against the repo and aggregate raw pair events into
 *  a single `FilePair[]` sorted descending by count. Filter by
 *  `min_count` to drop singletons. */
export function collectCoChange(opts: CoChangeOptions): FilePair[] {
  const args = [
    "log",
    "--name-only",
    "--pretty=format:%H",
    `--since=${opts.since_days}.days.ago`,
    "-M",
  ].join(" ");
  const log = execSync(`git -C ${shellQuote(opts.repo_path)} ${args}`, {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const counts = new Map<string, FilePair>();
  for (const ev of parseCoChangeLog(log, { big_commit_threshold: opts.big_commit_threshold })) {
    const key = `${ev.a} ${ev.b}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { a: ev.a, b: ev.b, count: 1 });
  }
  return [...counts.values()]
    .filter((p) => p.count >= opts.min_count)
    .sort((a, b) => b.count - a.count);
}

function shellQuote(s: string): string {
  // execSync with a shell string — quote the path defensively.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Write a `FilePair[]` to JSONL (one pair per line). Caller-supplied path. */
export function writeCoChangeJsonl(pairs: FilePair[], outPath: string): void {
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: tsx co-change.ts <repo-path> [--out <path>] [--since-days N] [--big N] [--min N]");
    process.exit(2);
  }
  const repo_path = resolve(args[0]!);
  let outPath: string | null = null;
  let since_days = 180;
  let big_commit_threshold = 50;
  let min_count = 2;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out") outPath = args[++i]!;
    else if (args[i] === "--since-days") since_days = Number(args[++i]);
    else if (args[i] === "--big") big_commit_threshold = Number(args[++i]);
    else if (args[i] === "--min") min_count = Number(args[++i]);
  }
  const pairs = collectCoChange({ repo_path, since_days, big_commit_threshold, min_count });
  if (outPath) {
    writeCoChangeJsonl(pairs, outPath);
    console.log(`[co-change] wrote ${pairs.length} pairs to ${outPath}`);
  } else {
    for (const p of pairs) console.log(JSON.stringify(p));
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("co-change.ts");
if (isDirect) main();
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/frame-extraction/co-change.test.ts 2>&1 | tail -10
```

Expected: all 9 tests pass.

- [ ] **Step 5: Wire into `package.json`**

Open `package.json` and add inside `"scripts"` after `"survey:report"`:

```json
    "co-change": "tsx scripts/frame-extraction/co-change.ts"
```

- [ ] **Step 6: Smoke-test against the cortex repo itself**

```bash
npm run co-change -- . --out .tmp/frame-extraction/co-change/self-cortex.jsonl --min 2
head -5 .tmp/frame-extraction/co-change/self-cortex.jsonl
```

Expected: one line per file-pair with `{"a":"…","b":"…","count":N}`, sorted descending by `count`. The top pair will likely involve test files or `package.json` ↔ `package-lock.json` if untouched-since defaults.

- [ ] **Step 7: Commit**

```bash
git add scripts/frame-extraction/co-change.ts tests/frame-extraction/co-change.test.ts package.json
git commit -m "feat(frame-extraction): git-log co-change matrix"
```

---

## Task 6: Verify the full test suite and push

- [ ] **Step 1: Run the full suite**

```bash
npm test
```

Expected: all tests pass. The baseline before this branch was 385 pass + 1 skipped (at the merge of PR #4). After this plan, count grows by ~22 (4 path-tokenize tests, 4 parseCoChangeLog tests, 4 collectCoChange tests, plus the existing 14 path-tokenize sub-tests counted individually under describe blocks — actual count depends on test runner grouping).

If the count drops, fix and re-run before continuing.

- [ ] **Step 2: Final code-review pass**

Dispatch a code-reviewer agent against the cumulative branch diff (base = current main `8c7cfcd`). Address any critical findings before opening the PR.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feature/frame-extraction/phase-2-shared-infra
gh pr create --title "feat(frame-extraction): Phase 2 shared infrastructure" --body "$(cat <<'EOF'
## Summary

Shared infrastructure for Phase 2 clustering candidates:

- **Phase 2 corpus** — 5 repos covering the archetypes from frame-extraction.md §Verification §Phase 2: Nuxt app, React SPA, Go service, Python ML, TS monorepo.
- **Framework-aware path tokenizer** — strips conventional segments (src/app/components/cmd/internal/...) and role suffixes (.service/.helper/.test), with the service-suffix edge case handled. Used by Leiden as a Jaccard component and by TF-IDF/embedding pipelines as part of per-file text.
- **Co-change matrix** — git-log based, 180-day default window, drops big-commit format passes, returns FilePair[] sorted desc by count. CLI for ad-hoc use, programmatic API for downstream algorithms.

No new npm deps. All TS. Python comes with the next plan (first clustering candidate).

## Test plan

- [x] npm test — all green
- [x] Tokenizer fixture cases cover universal/frontend/backend strip + camel/snake/kebab split + service-suffix edge case
- [x] Co-change tested via a synthetic git repo with deterministic commits + a big-commit drop case + min_count filter
- [x] CLI smoke against cortex itself produces a valid JSONL co-change output

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Phase 2 §Verification asks for a 5-archetype corpus (✓ Task 1), framework-aware path tokenization (✓ Task 3), and co-change as a semantic signal (✓ Task 5). Phase 2's 8 eval metrics, the 3 clustering algorithms, and the eval harness itself are deliberately *out of scope* for this plan — they're separate, larger pieces of work that build on this layer.
- **Open question §10** (service-suffix stripping edge case) is addressed in `path-tokenize.ts` via the `service_suffix_aware` flag and tested via the `service.service.ts` fixture.
- **Open question §8** (big-commit threshold = 50) and **§9** (180-day window) are exposed as `CoChangeOptions` fields with the spec's starter values as defaults, so Phase 2 can calibrate.
- **Open question §5** (name-token similarity via Jaccard vs edit distance) is not addressed here — the tokenizer returns ordered Sets, and Jaccard/edit distance computation lives with the Leiden algorithm in a future plan.
- **No placeholders:** every step contains either complete code or an exact command with expected output.
- **Branch:** `feature/frame-extraction/phase-2-shared-infra` matches workflow.md naming.
- **Gates:** Gate 0 (visual QA) N/A (no UI). Gate 1 (code review) is Step 2 of Task 6. Gate 2 (QA) — the script is research tooling not a runtime feature, so the QA agent's checks (build health, dark-mode compliance, API auth) don't really apply; npm test passing is the meaningful signal.
