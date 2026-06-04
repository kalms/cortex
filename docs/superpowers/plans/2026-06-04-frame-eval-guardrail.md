# Frame-Extraction Eval Guardrail (Plan 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a committed, one-command eval guardrail for frame extraction — an expanded corpus (framework apps + anthill), a machine-checkable label-quality check, a corpus-wide runner, and a baseline report — so Phases 1–3 can be measured and cannot silently regress.

**Architecture:** Reuse the existing harness (`corpus.json` → `clone`/`indexer` → `runTfIdfHdbscan` → `eval-metrics`/`eval-edges`). Add (a) framework fixtures to `corpus.json`, (b) a pure `eval-labels.ts` that scores labels against the spec's readability rules using the existing `pickFrameLabel`, (c) an `eval-all.ts` orchestrator that runs cluster + metrics + label-check across the corpus and writes one aggregated JSON, (d) a committed baseline snapshot of that JSON.

**Tech Stack:** TypeScript (tsx, better-sqlite3), the in-repo vitest suite (`tests/frame-extraction/`), the Python venv (existing — for clustering only).

**Spec:** [docs/superpowers/specs/2026-06-04-import-aware-frame-extraction-design.md](../specs/2026-06-04-import-aware-frame-extraction-design.md) §4, §11.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/frame-extraction/corpus.json` | Corpus fixture list (`RepoSpec[]`). | Modify — add 4 fixtures |
| `src/frame-extraction/eval-labels.ts` | **New.** Pure functions: given clusters + top-tokens, compute each cluster's label (via existing `pickFrameLabel`) and return rule violations. No I/O. | Create |
| `tests/frame-extraction/eval-labels.test.ts` | **New.** Unit tests for the label rules over synthetic clusters. | Create |
| `scripts/frame-extraction/eval-all.ts` | **New.** Corpus-wide orchestrator: per repo, cluster → metrics (reuse) → label-check → aggregate into one JSON report. | Create |
| `scripts/frame-extraction/baselines/2026-06-04.json` | **New.** Committed baseline snapshot the later phases diff against. | Create (generated) |
| `package.json` | Add an `eval:frames` script alias. | Modify |

`eval-labels.ts` lives in `src/` (not `scripts/`) because it is pure, unit-tested logic that Phase 1 will also consume; the orchestrator that does I/O stays in `scripts/`.

---

## Task 1: Add framework fixtures to the corpus

**Files:**
- Modify: `scripts/frame-extraction/corpus.json`
- Test: `tests/frame-extraction/corpus-fixtures.test.ts` (Create)

**Proposed fixtures (CONFIRM with the user before cloning — these are vetoable):**
- **Next.js App Router:** `vercel/commerce` (MIT) — real App Router e-commerce app.
- **Django:** `saleor/saleor` (BSD-3) — real Django app; `size_hint: large` (flag index cost).
- **Rails:** `discourse/discourse` (GPL-2) — canonical real Rails MVC app. *License note:* we only clone+index locally for measurement; no redistribution/derivation, so copyleft is acceptable for an eval fixture. If you prefer permissive, swap to `gitlabhq/gitlabhq` (MIT-core).
- **anthill-cloud:** local-only (`git: null`, `local_path` to the absolute repo), `archetype: nuxt-app`. Marked local so portable/CI runs skip it.

- [ ] **Step 1: CHECKPOINT — confirm the four repos with the user.** Do not proceed until the Next/Django/Rails picks (and the Rails license choice) are confirmed. Record the confirmed slugs.

- [ ] **Step 2: Write the failing schema test**

`tests/frame-extraction/corpus-fixtures.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CorpusFile, RepoSpec } from "../../src/frame-extraction/types.js";

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, "../../scripts/frame-extraction/corpus.json"), "utf-8"),
) as CorpusFile;

function bySlug(s: string): RepoSpec | undefined {
  return corpus.repos.find((r) => r.slug === s);
}

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
      expect(hasGit || hasLocal).toBe(true); // at least one source
    }
  });

  it("anthill-cloud is a local-only fixture", () => {
    const a = corpus.repos.find((r) => r.slug.includes("anthill"));
    expect(a).toBeDefined();
    expect(a!.git).toBeNull();
    expect(a!.local_path).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/frame-extraction/corpus-fixtures.test.ts`
Expected: FAIL — `next-app`/`django-app`/`rails-app` not present, anthill missing.

- [ ] **Step 4: Add the confirmed fixtures to `corpus.json`**

Append to `repos` (substitute the confirmed slugs/URLs from Step 1; `<ABS>` = the absolute anthill path, e.g. `/Users/rka/Development/anthill-cloud`):

```json
,
{ "slug": "vercel/commerce",     "git": "https://github.com/vercel/commerce.git",     "archetype": "next-app",   "size_hint": "medium", "primary_language": "typescript" },
{ "slug": "saleor/saleor",       "git": "https://github.com/saleor/saleor.git",       "archetype": "django-app", "size_hint": "large",  "primary_language": "python" },
{ "slug": "discourse/discourse", "git": "https://github.com/discourse/discourse.git", "archetype": "rails-app",  "size_hint": "large",  "primary_language": "ruby" },
{ "slug": "local/anthill-cloud", "git": null, "local_path": "<ABS>", "archetype": "nuxt-app", "size_hint": "medium", "primary_language": "typescript" }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/frame-extraction/corpus-fixtures.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 6: Smoke-clone + index the new public fixtures (manual, network)**

Run: `npx tsx scripts/frame-extraction/survey.ts --only vercel/commerce`
Then repeat `--only saleor/saleor` and `--only discourse/discourse`.
Expected: each prints `✓ entities=… edges=… files=…`. If any errors at `phase: index` (language/extraction gap), record it — that repo may need `size_hint`/exclusion tuning, and the §10 cross-language caveat applies. Do NOT block the plan on a single repo's index quality; note it and continue.

- [ ] **Step 7: Commit**

```bash
git add scripts/frame-extraction/corpus.json tests/frame-extraction/corpus-fixtures.test.ts
git commit -m "test(frames): add framework + anthill fixtures to eval corpus"
```

---

## Task 2: Label-quality checker (`eval-labels.ts`)

**Files:**
- Create: `src/frame-extraction/eval-labels.ts`
- Test: `tests/frame-extraction/eval-labels.test.ts`

The checker computes each cluster's label with the **existing** `pickFrameLabel` and flags violations of the spec's rules. At baseline (pre-Phase-1) it will legitimately report violations — that is the point; Phase 1 drives them to zero.

- [ ] **Step 1: Write the failing tests**

`tests/frame-extraction/eval-labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkLabelQuality } from "../../src/frame-extraction/eval-labels.js";
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

// helper: cluster with explicit member paths
function cl(id: number, paths: string[]): ClusterAssignment {
  return { cluster_id: id, member_paths: paths, size: paths.length } as ClusterAssignment;
}

describe("checkLabelQuality", () => {
  it("flags a label driven by a single member (no >=50% shared token)", () => {
    // 'email' appears in 1 of 5 paths -> not majority -> should NOT be the label
    const clusters = [cl(0, [
      "apps/x/app/pages/x/banners.vue",
      "apps/x/app/pages/x/briefs.vue",
      "apps/x/app/pages/x/email.vue",
      "apps/x/app/pages/x/slides.vue",
      "apps/x/app/pages/x/index.vue",
    ])];
    const topTokens = { "0": ["email", "x", "pages"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.find((x) => x.cluster_id === 0)?.rule).toBe("non_salient_label");
  });

  it("flags a bracketed route-param token in the label", () => {
    const clusters = [cl(1, ["a/orgs/[orgId]/x.ts", "a/orgs/[orgId]/y.ts"])];
    const topTokens = { "1": ["orgid design", "design"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.find((x) => x.cluster_id === 1)?.rule).toBe("structural_token_in_label");
  });

  it("flags a bare MVC layer marker as the label", () => {
    const clusters = [cl(2, ["app/controllers/a.rb", "app/controllers/b.rb"])];
    const topTokens = { "2": ["controller"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.find((x) => x.cluster_id === 2)?.rule).toBe("structural_token_in_label");
  });

  it("passes a clean domain label shared across members", () => {
    const clusters = [cl(3, ["pkg/dsl/compiler/a.ts", "pkg/dsl/compiler/b.ts", "pkg/dsl/compiler/c.ts"])];
    const topTokens = { "3": ["compiler", "dsl"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.filter((x) => x.cluster_id === 3)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/frame-extraction/eval-labels.test.ts`
Expected: FAIL — `checkLabelQuality` not exported.

- [ ] **Step 3: Implement `eval-labels.ts`**

```ts
// src/frame-extraction/eval-labels.ts
import { pickFrameLabel } from "./inject-frames.js";
import type { ClusterAssignment } from "./types.js";

/** Structural-not-topical tokens that must never stand as a frame label.
 *  Shared with Phase 1's tokenizer when it lands. Lowercase. */
export const STRUCTURAL_LABEL_TOKENS = new Set<string>([
  // convention affixes
  "use",
  // MVC layer markers
  "controller", "controllers", "model", "models", "view", "views",
  "serializer", "serializers", "migration", "migrations", "schema",
]);

/** True if a token is a bracketed dynamic route segment or a structural token. */
export function isStructuralLabelToken(token: string): boolean {
  const t = token.toLowerCase();
  if (/^\[.*\]$/.test(t) || /^\(.*\)$/.test(t)) return true; // [param], (group)
  // de-bracketed route param leakage, e.g. "orgid" from [orgId]
  if (/^\[?[a-z]*id\]?$/.test(t) && t !== "id") {
    // covers orgid, dsid, userid… as label tokens (route-param-derived)
    return true;
  }
  return STRUCTURAL_LABEL_TOKENS.has(t);
}

export interface LabelViolation {
  cluster_id: number;
  label: string;
  rule: "structural_token_in_label" | "non_salient_label";
  detail: string;
}

/** Fraction of member paths whose path contains `token` (case-insensitive). */
function pathSalience(token: string, memberPaths: readonly string[]): number {
  if (memberPaths.length === 0) return 0;
  const t = token.toLowerCase();
  let hits = 0;
  for (const p of memberPaths) if (p.toLowerCase().includes(t)) hits++;
  return hits / memberPaths.length;
}

/** Run the current labeler over each cluster and return rule violations. */
export function checkLabelQuality(
  clusters: readonly ClusterAssignment[],
  topTokensPerCluster: Record<string, string[]>,
): LabelViolation[] {
  const out: LabelViolation[] = [];
  for (const c of clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokensPerCluster[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.member_paths, c.cluster_id);
    const words = label.toLowerCase().split(/\s+/).filter(Boolean);

    // Rule 1: no structural token may appear in the label.
    const bad = words.find((w) => isStructuralLabelToken(w));
    if (bad) {
      out.push({ cluster_id: c.cluster_id, label, rule: "structural_token_in_label", detail: bad });
      continue;
    }

    // Rule 2: every label word must be salient across >=50% of members,
    // UNLESS the label came from the path-prefix fallback (in which case it
    // is a directory shared by all members and salience is trivially high).
    const weak = words.find((w) => pathSalience(w, c.member_paths) < 0.5);
    if (weak) {
      out.push({ cluster_id: c.cluster_id, label, rule: "non_salient_label", detail: weak });
    }
  }
  return out;
}
```

(Confirm `pickFrameLabel` is exported from `inject-frames.ts` — it is, per the spec's references. Confirm `ClusterAssignment` has `member_paths`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/frame-extraction/eval-labels.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/eval-labels.ts tests/frame-extraction/eval-labels.test.ts
git commit -m "feat(frames): label-quality checker for eval guardrail"
```

---

## Task 3: Corpus-wide eval runner (`eval-all.ts`)

**Files:**
- Create: `scripts/frame-extraction/eval-all.ts`

Orchestrates, per corpus repo: ensure clone/index → `runTfIdfHdbscan` → compute `EvalMetrics` (reuse `eval-metrics.ts` + `eval-edges.ts`) → `checkLabelQuality` → collect one row. Writes a single aggregated JSON.

- [ ] **Step 1: Implement the orchestrator**

```ts
// scripts/frame-extraction/eval-all.ts
/**
 * Corpus-wide frame eval. For each repo in corpus.json: cluster, score
 * cross-signal metrics, and check label quality. Emits one aggregated JSON.
 *
 * Usage: tsx scripts/frame-extraction/eval-all.ts [--out <path>] [--only <slug>] [--skip-clone]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClone } from "./clone.js";
import { callIndexer } from "./indexer.js";
import { runTfIdfHdbscan, deriveProjectName } from "../../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { collectCallsEdges } from "./eval-edges.js";
import { agreementScore, noiseRate, clusterCount, buildFileToClusterMap } from "./eval-metrics.js";
import { checkLabelQuality } from "../../src/frame-extraction/eval-labels.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";
import type { CorpusFile } from "../../src/frame-extraction/types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

interface RepoEvalRow {
  slug: string;
  ok: boolean;
  error?: string;
  cluster_count?: number;
  noise_rate?: number;
  import_agreement_strict?: number | null;
  label_violations?: number;
  violation_rules?: Record<string, number>;
}

function parseArgs(argv: string[]) {
  const a: { out?: string; only?: string; skipClone?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--only") a.only = argv[++i];
    else if (argv[i] === "--skip-clone") a.skipClone = true;
  }
  return a;
}

async function evalRepo(repo: CorpusFile["repos"][number]): Promise<RepoEvalRow> {
  if (repo.git === null && !repo.local_path) return { slug: repo.slug, ok: false, error: "no source" };
  const clone = ensureClone(repo);
  if (!clone.ok) return { slug: repo.slug, ok: false, error: `clone: ${clone.error}` };

  const idx = callIndexer<{ project: string }>("index_repository", { repo_path: clone.path });
  if (!idx.ok) return { slug: repo.slug, ok: false, error: `index: ${idx.error}` };
  const project = idx.data.project;

  let clusterResult;
  try {
    clusterResult = runTfIdfHdbscan({ repo_path: clone.path, project_name: project }).result;
  } catch (e) {
    return { slug: repo.slug, ok: false, error: `cluster: ${e instanceof Error ? e.message : String(e)}` };
  }

  const fileToCluster = buildFileToClusterMap(clusterResult.clusters);
  const callsEdges = collectCallsEdges(clone.path, project);
  const importAgreement = agreementScore(callsEdges, fileToCluster, "strict");

  const topTokens =
    ((clusterResult.parameters ?? {}) as Record<string, unknown>)["top_tokens_per_cluster"] as
      | Record<string, string[]>
      | undefined ?? {};
  const violations = checkLabelQuality(clusterResult.clusters, topTokens);
  const violationRules: Record<string, number> = {};
  for (const v of violations) violationRules[v.rule] = (violationRules[v.rule] ?? 0) + 1;

  return {
    slug: repo.slug,
    ok: true,
    cluster_count: clusterCount(clusterResult.clusters),
    noise_rate: noiseRate(clusterResult.clusters),
    import_agreement_strict: importAgreement,
    label_violations: violations.length,
    violation_rules: violationRules,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!hasVenv()) {
    console.error("Python venv missing — run `cortex install` / setup-venv.sh first.");
    process.exit(2);
  }
  const corpus = JSON.parse(
    readFileSync(join(REPO_ROOT, "scripts", "frame-extraction", "corpus.json"), "utf-8"),
  ) as CorpusFile;
  const repos = args.only ? corpus.repos.filter((r) => r.slug.includes(args.only!)) : corpus.repos;

  const rows: RepoEvalRow[] = [];
  for (const repo of repos) {
    console.log(`[eval-all] → ${repo.slug}`);
    const row = await evalRepo(repo);
    rows.push(row);
    console.log(
      row.ok
        ? `  ✓ clusters=${row.cluster_count} noise=${row.noise_rate?.toFixed(2)} agree=${row.import_agreement_strict ?? "n/a"} labelViol=${row.label_violations}`
        : `  ✗ ${row.error}`,
    );
  }

  const report = { generated_at: new Date().toISOString(), rows };
  const outPath = args.out ?? join(REPO_ROOT, ".tmp", "frame-extraction", "eval-all.json");
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[eval-all] wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

(Confirm exact signatures while implementing: `agreementScore(pairs, map, mode)`, `collectCallsEdges(repoPath, project)`, `ensureClone`/`callIndexer` shapes — they are used by `survey.ts`/`eval.ts`; mirror those call sites. `new Date().toISOString()` is fine in a script (the Date restriction applies only to Workflow scripts, not normal tsx scripts).)

- [ ] **Step 2: Smoke-run on one fast repo**

Run: `npx tsx scripts/frame-extraction/eval-all.ts --only cobra --skip-clone`
Expected: prints one `✓ clusters=… noise=… agree=… labelViol=…` row and writes `.tmp/frame-extraction/eval-all.json`. If signatures differ, fix to match the real `eval-metrics.ts`/`eval-edges.ts` exports, re-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/eval-all.ts
git commit -m "feat(frames): corpus-wide eval runner (metrics + label quality)"
```

---

## Task 4: Generate and commit the baseline

**Files:**
- Create: `scripts/frame-extraction/baselines/2026-06-04.json`

- [ ] **Step 1: Run the full corpus (network + venv; slow)**

Run: `npx tsx scripts/frame-extraction/eval-all.ts --out scripts/frame-extraction/baselines/2026-06-04.json`
Expected: one row per repo. Public repos cloned; `local/anthill-cloud` evaluated from its local path. Repos that fail to index are recorded with `ok:false` (acceptable — note them).

- [ ] **Step 2: Sanity-check the baseline reflects the known issues**

Confirm the baseline JSON shows: `self/cortex` has `label_violations > 0` (e.g. the `cli commands`/`use store` issues) and a non-trivial `noise_rate`, and `local/anthill-cloud` shows label violations (`orgid`/route-param/`use`). This proves the checker detects what we set out to fix. If violations are 0 everywhere, the checker is too lax — revisit Task 2 before committing.

- [ ] **Step 3: Commit the baseline**

```bash
git add scripts/frame-extraction/baselines/2026-06-04.json
git commit -m "chore(frames): commit eval baseline (pre-improvement)"
```

---

## Task 5: One-command alias + usage doc

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the npm script**

In `package.json` `"scripts"`, add:

```json
"eval:frames": "tsx scripts/frame-extraction/eval-all.ts"
```

- [ ] **Step 2: Verify it runs**

Run: `npm run eval:frames -- --only cobra --skip-clone`
Expected: same output as Task 3 Step 2 (one row).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(frames): add eval:frames npm alias"
```

---

## Self-Review

- **Spec §4 coverage:** corpus preserved + framework/anthill fixtures (Task 1); `import_agreement_strict` + `noise_rate` reused (Task 3); label-quality rules — structural-token + salience (Task 2); baseline as the regression bar (Task 4); one-command runner (Tasks 3, 5). Sweep-based tuning is a Phase-2/3 concern, not Plan 0.
- **§11 coverage:** this is Plan 0, the prerequisite; it ships independently and is usable by Phases 1–3.
- **Placeholders:** none — all code shown; the only deferred decision (which exact repos) is an explicit user CHECKPOINT in Task 1 Step 1 with concrete proposals.
- **Type consistency:** `checkLabelQuality(clusters, topTokensPerCluster)` and `LabelViolation.rule` (`structural_token_in_label` | `non_salient_label`) are used identically in Tasks 2 and 3; `isStructuralLabelToken` and `STRUCTURAL_LABEL_TOKENS` are defined once and exported for Phase 1 reuse.
- **Known caveat:** Task 1 Step 6 and Task 4 Step 1 explicitly tolerate per-repo index failures (cross-language extraction maturity, spec §10) rather than blocking the guardrail.
