# `cluster:N` Labeling Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover real frame labels for clusters that currently fall back to opaque `cluster:N`, via a directory-aware char rule, a relaxed last-resort pass, and an honest directory descriptor.

**Architecture:** All changes are in `src/frame-extraction/inject-frames.ts` (the labeler) + its test. One global change (directory-aware ≤2-char rule, affects all passes), one last-resort recovery pass (`relaxedRecoveryLabel`, reached only when passes 1–4 fail), and a directory descriptor that replaces raw `cluster:N`.

**Tech Stack:** TypeScript, vitest. The labeler is a pure module (graph rows / tokens / paths in, label string out).

## Global Constraints

- Determinism: sorted/stable ordering; no randomness. Same input → same label.
- The relaxed recovery (Pass 4.5) and descriptor are reached ONLY after passes 1–4 fail — they must never displace a label an existing pass would produce.
- Route-param tokens, bracketed/dynamic segments, and repo-ubiquitous suppressed terms are NEVER acceptable labels, even in the relaxed pass.
- The descriptor fallback carries NO file/node count (the viewer already renders counts).
- `cluster:N` remains only as the absolute floor (when even the descriptor finds nothing) — expected to essentially never appear after this change.
- Relaxed salience floor = `0.3`. The ≤2-char length rule is the only generic check relaxed globally; `GENERIC_TOKENS` set membership is unchanged in the normal passes.

---

### Task 1: Directory-aware ≤2-char rule (global)

**Files:**
- Modify: `src/frame-extraction/inject-frames.ts` (add `isDirectorySegment`; update `isLabelEligibleWord` and the `consider()` filter inside `dominantPathSegmentLabel`)
- Test: `tests/frame-extraction/inject-frames.test.ts`

**Interfaces:**
- Produces: `isDirectorySegment(token: string, memberPaths: readonly string[]): boolean` (module-private). No exported-signature changes — `pickFrameLabel` keeps its current signature.

- [ ] **Step 1: Write the failing test**

Add to `tests/frame-extraction/inject-frames.test.ts`:

```ts
import { pickFrameLabel } from "../../src/frame-extraction/inject-frames.js";

describe("pickFrameLabel — directory-aware short tokens (cluster:N recovery)", () => {
  it("labels a cluster after a ≤2-char DIRECTORY segment (ws)", () => {
    const paths = ["src/ws/server.ts", "src/ws/protocol.ts", "src/ws/client-registry.ts", "tests/ws/server.test.ts"];
    // 'ws' is the top token and a real directory in 3/4 members.
    expect(pickFrameLabel(["ws", "server"], paths, 2)).toBe("ws");
  });
  it("does NOT label after a ≤2-char FILENAME-STEM token (ts) — stays generic", () => {
    const paths = ["src/core/a.ts", "src/core/b.ts", "src/core/c.ts"];
    // 'ts' is only an extension/stem, never a directory → still rejected; falls to path prefix 'core'(generic)→ cluster:N
    expect(pickFrameLabel(["ts", "id"], paths, 7)).toBe("cluster:7");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts -t "directory-aware"`
Expected: FAIL — first case returns `cluster:2` because `ws` is rejected by the ≤2-char rule.

- [ ] **Step 3: Add the helper and make the two eligibility sites directory-aware**

In `src/frame-extraction/inject-frames.ts`, add this helper near `isGenericToken` (after its definition, ~line 66):

```ts
/** True when `token` (already lowercased) appears as a DIRECTORY segment — any
 *  path segment except the final (filename) one — in at least one member path.
 *  A short token that names a real subsystem directory (`ws`, `io`, `db`) is a
 *  legitimate label; the same token appearing only as a filename stem/extension
 *  (`ts`, `js`) is noise. Lets the ≤2-char generic rule be relaxed for the
 *  former without admitting the latter. */
function isDirectorySegment(token: string, memberPaths: readonly string[]): boolean {
  for (const p of memberPaths) {
    const segs = p.split("/").filter((s) => s.length > 0);
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i]!.toLowerCase() === token) return true;
    }
  }
  return false;
}
```

In `isLabelEligibleWord`, replace the line `if (isGenericToken(w)) return false;` with:

```ts
  // Stop-list (any length) always rejects. The ≤2-char rule is relaxed for a
  // token that names a real directory segment (a subsystem like `ws`), but not
  // for a short filename stem/extension.
  if (GENERIC_TOKENS.has(w)) return false;
  if (w.length <= 2 && !isDirectorySegment(w, memberPaths)) return false;
```

In `dominantPathSegmentLabel`, inside the `consider` closure, replace `isGenericToken(lower)` in the guard with the directory-aware form. The current guard is:

```ts
      if (isDynamicSegment(lower) || isGenericToken(lower) ||
          isStructuralLabelToken(lower) || params.has(lower) || suppressedTerms.has(lower)) return;
```

Replace with:

```ts
      const shortStem = lower.length <= 2 && !isDirectorySegment(lower, paths);
      if (isDynamicSegment(lower) || GENERIC_TOKENS.has(lower) || shortStem ||
          isStructuralLabelToken(lower) || params.has(lower) || suppressedTerms.has(lower)) return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts`
Expected: PASS — the new `ws` case returns `"ws"`, the `ts` stem case returns `"cluster:7"`, and ALL pre-existing `inject-frames` tests still pass (the change only adds eligibility for short directory tokens).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/inject-frames.ts tests/frame-extraction/inject-frames.test.ts
git commit -m "feat(frames): directory-aware ≤2-char label rule (recovers ws-style subsystem dirs)"
```

---

### Task 2: `relaxedRecoveryLabel` (Pass 4.5)

**Files:**
- Modify: `src/frame-extraction/inject-frames.ts` (add `minFraction` param to `dominantPathSegmentLabel`; add `relaxedRecoveryLabel`; insert Pass 4.5 into `pickFrameLabel`)
- Test: `tests/frame-extraction/inject-frames.test.ts`

**Interfaces:**
- Consumes: `isDirectorySegment` (Task 1), `formatPathOrderedLabel`, `pathSalience`, `isStructuralLabelToken`, `GENERIC_TOKENS`.
- Produces: `relaxedRecoveryLabel(topTokens: readonly string[], memberPaths: readonly string[], params: ReadonlySet<string>, suppressedTerms: ReadonlySet<string>): string | null`; `dominantPathSegmentLabel` gains an optional `minFraction?: number` (when omitted, strict >50% as today; when given, includes segments at ≥ that fraction).

- [ ] **Step 1: Write the failing tests (the audited Mode A + Mode B cases)**

```ts
describe("pickFrameLabel — relaxed recovery (Pass 4.5)", () => {
  it("recovers a generic-but-salient token (index-meta) instead of cluster:N", () => {
    const paths = ["src/graph/capture-index-meta.ts", "src/graph/index-meta.ts", "tests/graph/capture-index-meta.test.ts"];
    // top tokens are generic ('index','meta') so passes 1-2 reject; 4.5 allows them.
    const label = pickFrameLabel(["index meta", "meta", "index"], paths, 5);
    expect(label).not.toMatch(/^cluster:/);
    expect(label.toLowerCase()).toContain("index");
  });
  it("recovers a plurality (Mode B) token via the lowered salience bar", () => {
    // 'allocator' is salient in ~40% of members (below the strict 0.5 gate).
    const paths = ["src/ids/allocator.ts", "src/ids/short-id.ts", "tests/ids/allocator.test.ts", "tests/decisions/db-todos.test.ts", "tests/decisions/short-id-mint.test.ts"];
    const label = pickFrameLabel(["allocator", "mint", "fresh"], paths, 6);
    expect(label).not.toMatch(/^cluster:/);
  });
  it("still excludes route-params even in the relaxed pass", () => {
    const paths = ["app/users/[id]/page.tsx", "app/posts/[id]/page.tsx"];
    // '[id]' dynamic + 'id' route-param must never become a label; no other signal → cluster:N
    expect(pickFrameLabel(["id"], paths, 9)).toBe("cluster:9");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts -t "relaxed recovery"`
Expected: FAIL — the index-meta and allocator cases currently return `cluster:5` / `cluster:6`.

- [ ] **Step 3: Add `minFraction` to `dominantPathSegmentLabel`**

Change the signature:

```ts
function dominantPathSegmentLabel(
  paths: readonly string[],
  suppressedTerms: ReadonlySet<string> = EMPTY_TERMS,
  minFraction?: number,
): string | null {
```

Replace the strict-majority guard `if (c.count / total <= 0.5) continue;` with:

```ts
    // Default (minFraction undefined): strict majority (>50%), unchanged. When
    // a relaxed floor is supplied, include any segment at ≥ that fraction.
    const frac = c.count / total;
    if (minFraction === undefined ? frac <= 0.5 : frac < minFraction) continue;
```

- [ ] **Step 4: Add `relaxedRecoveryLabel`**

Add after `dominantPathSegmentLabel`:

```ts
/** Last-resort recovery, reached only when passes 1–4 fail. Relaxes the normal
 *  gate in two ways: (1) allows `GENERIC_TOKENS` members (deprioritized below
 *  non-generic), (2) lowers the salience floor to 0.3 (recovers a plurality
 *  token in a mixed cluster). NEVER accepts a route-param, dynamic segment,
 *  short filename stem, or repo-ubiquitous suppressed term. Returns null when
 *  no token or segment clears the relaxed bar. */
function relaxedRecoveryLabel(
  topTokens: readonly string[],
  memberPaths: readonly string[],
  params: ReadonlySet<string>,
  suppressedTerms: ReadonlySet<string> = EMPTY_TERMS,
): string | null {
  const SALIENCE_FLOOR = 0.3;
  const recoverable = (w: string, allowGeneric: boolean): boolean => {
    if (isStructuralLabelToken(w)) return false;
    if (params.has(w)) return false;
    if (suppressedTerms.has(w)) return false;
    if (w.length <= 2 && !isDirectorySegment(w, memberPaths)) return false;
    if (!allowGeneric && GENERIC_TOKENS.has(w)) return false;
    if (memberPaths.length > 0 && pathSalience(w, memberPaths) < SALIENCE_FLOOR) return false;
    return true;
  };
  // Two sweeps: non-generic tokens first (preferred), then generic-but-real.
  for (const allowGeneric of [false, true]) {
    for (const token of topTokens) {
      const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
      if (parts.length > 1 && parts.every((p) => recoverable(p, allowGeneric))) {
        return formatPathOrderedLabel(token, memberPaths);
      }
      if (parts.length === 1 && recoverable(parts[0]!, allowGeneric)) {
        return token;
      }
    }
  }
  // Finally: dominant path segment at the relaxed floor.
  return dominantPathSegmentLabel(memberPaths, suppressedTerms, SALIENCE_FLOOR);
}
```

- [ ] **Step 5: Insert Pass 4.5 into `pickFrameLabel`**

In `pickFrameLabel`, between the Pass 4 block (`const dominant = dominantPathSegmentLabel(...); if (dominant) return dominant;`) and the `return \`cluster:${clusterId ?? "?"}\`;` line, insert:

```ts
  // Pass 4.5: relaxed last-resort recovery before the opaque fallback.
  const recovered = relaxedRecoveryLabel(topTokens, memberPaths, params, suppressedTerms);
  if (recovered) return recovered;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts`
Expected: PASS — index-meta and allocator cases now return real labels; the route-param case still returns `cluster:9`; all prior tests green.

- [ ] **Step 7: Commit**

```bash
git add src/frame-extraction/inject-frames.ts tests/frame-extraction/inject-frames.test.ts
git commit -m "feat(frames): Pass 4.5 relaxed label recovery before cluster:N"
```

---

### Task 3: Honest directory descriptor fallback

**Files:**
- Modify: `src/frame-extraction/inject-frames.ts` (add `descriptorLabel`; use it before the `cluster:N` floor)
- Test: `tests/frame-extraction/inject-frames.test.ts`

**Interfaces:**
- Consumes: `isGenericToken`, `isStructuralLabelToken`.
- Produces: `descriptorLabel(memberPaths: readonly string[]): string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("pickFrameLabel — directory descriptor fallback", () => {
  it("uses dominant informative dir(s), no file count, instead of cluster:N", () => {
    // Genuinely mixed, no salient token at all → descriptor from dir frequency.
    const paths = ["src/decisions/x.ts", "tests/decisions/y.ts", "src/todos/z.ts", "tests/api/q.ts"];
    const label = pickFrameLabel([], paths, 11); // no top tokens → passes 1-2,4.5-token all skip
    expect(label).not.toMatch(/^cluster:/);
    expect(label).not.toMatch(/\d+\s*files?/i);   // NO count in the label
    expect(label).toMatch(/decisions|todos|api/);
  });
  it("falls to cluster:N only when there is no informative directory at all", () => {
    expect(pickFrameLabel([], ["a.ts", "b.ts"], 42)).toBe("cluster:42");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts -t "descriptor fallback"`
Expected: FAIL — the first case returns `cluster:11` today.

- [ ] **Step 3: Add `descriptorLabel` and use it before the floor**

Add after `relaxedRecoveryLabel`:

```ts
/** Honest last-ditch descriptor for a cluster with no salient token: the most
 *  frequent INFORMATIVE directory segments (generic/structural/org-root dirs
 *  like `src`, `tests`, `lib` excluded), top two, joined `/`. Carries no file
 *  count — the viewer renders counts separately. Returns null when no
 *  informative directory exists (then `cluster:N` is the floor). */
function descriptorLabel(memberPaths: readonly string[]): string | null {
  const counts = new Map<string, { original: string; n: number }>();
  for (const p of memberPaths) {
    const segs = p.split("/").filter((s) => s.length > 0);
    const seen = new Set<string>();
    for (let i = 0; i < segs.length - 1; i++) {
      const lower = segs[i]!.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      if (isGenericToken(lower) || isStructuralLabelToken(lower)) continue;
      const prev = counts.get(lower);
      if (prev) prev.n++;
      else counts.set(lower, { original: segs[i]!, n: 1 });
    }
  }
  if (counts.size === 0) return null;
  const sorted = [...counts.values()].sort(
    (a, b) => b.n - a.n || a.original.toLowerCase().localeCompare(b.original.toLowerCase()),
  );
  return sorted.slice(0, 2).map((c) => c.original).join("/");
}
```

Then change the final line of `pickFrameLabel` from:

```ts
  return `cluster:${clusterId ?? "?"}`;
```

to:

```ts
  // Honest directory descriptor before the opaque floor.
  const descriptor = descriptorLabel(memberPaths);
  if (descriptor) return descriptor;
  return `cluster:${clusterId ?? "?"}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts`
Expected: PASS — mixed-blob case returns an informative dir descriptor with no count; the root-only case returns `cluster:42`; all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/inject-frames.ts tests/frame-extraction/inject-frames.test.ts
git commit -m "feat(frames): honest directory descriptor fallback replacing raw cluster:N"
```

---

### Task 4: Validation (Cortex + corpus regression) and docs

**Files:**
- Modify: `docs/architecture/frame-extraction.md` (document the recovery passes)

- [ ] **Step 1: Run the full frame-extraction suite**

Run: `npx vitest run tests/frame-extraction/`
Expected: PASS (all existing tests + the new label-recovery cases). The existing `cluster-tfidf-hdbscan` / label-quality tests are the regression guard for the global char-rule change — if any fails, STOP and report.

- [ ] **Step 2: Confirm the direct target on Cortex (cluster:N drop)**

Run this one-off check (writes a temp script under the gitignored `.tmp/`, runs it, deletes it):

```bash
cat > .tmp/verify-clustern.ts <<'TS'
import { join } from "node:path";
import { runTfIdfHdbscan } from "../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { buildFrameAssignments } from "../src/frame-extraction/inject-frames.js";
const repo = "/Users/rka/Development/cortex";
const { result } = runTfIdfHdbscan({ repo_path: repo, db_path: join(repo, ".cortex", "db"), co_change_path: null, out_path: join(repo, ".tmp", "verify-cluster.json") });
const labels = new Map<number,string>();
for (const a of buildFrameAssignments(result)) labels.set(a.frame_id, a.frame_label);
const n = [...labels.values()].filter((l) => l.startsWith("cluster:")).length;
console.log("cluster:N count =", n, "of", labels.size, "frames");
console.log([...new Set(labels.values())].sort().join("\n"));
TS
npx tsx .tmp/verify-clustern.ts ; rm -f .tmp/verify-clustern.ts .tmp/verify-cluster.json
```
Expected: `cluster:N count` dropped from ~5 to 0–1; the printed labels include real names (`ws`, `ids` or `allocator`, an `index`-based label, etc.) and/or directory descriptors. Record the before/after in the task report.

- [ ] **Step 3: Corpus regression guard for the global char-rule change**

Run the corpus eval and compare label-quality against the checked-in baseline:

```bash
npx tsx scripts/frame-extraction/eval-all.ts 2>&1 | tail -40
```
Expected: corpus `label_f1_weighted` is not LOWER and `label_clusters_below_f1` is not HIGHER than `scripts/frame-extraction/baselines/2026-06-06.json` (improvement is fine). If the global directory-aware char rule regresses any repo's label-F1, narrow it to last-resort-only (move the `w.length <= 2` rescue out of `isLabelEligibleWord` into `relaxedRecoveryLabel` only) and re-run. Record the corpus numbers in the task report.

- [ ] **Step 4: Document the recovery passes**

In `docs/architecture/frame-extraction.md`, near the labeling/`pickFrameLabel` discussion, add:

```markdown
### Label recovery before `cluster:N`

`pickFrameLabel` no longer drops straight to the opaque `cluster:N` after its
four strict passes. Two recovery steps run first:

- **Directory-aware short tokens (all passes):** a ≤2-char token that names a
  real directory segment (`ws`, `io`, `db`) is eligible; the same token as a
  filename stem/extension (`ts`, `js`) stays rejected.
- **Pass 4.5 — relaxed recovery:** allows `GENERIC_TOKENS` members
  (deprioritized) and lowers the salience floor to 0.3, recovering a plurality
  token in a mixed cluster. Route-params, dynamic segments, and repo-ubiquitous
  terms are still excluded.
- **Directory descriptor:** if even Pass 4.5 finds nothing, the label is the
  dominant informative directory segment(s) (e.g. `decisions/todos`) — never
  a file count (the viewer renders counts). `cluster:N` remains only as the
  absolute floor and should essentially never appear.
```

- [ ] **Step 5: Commit + run the version-bump/merge protocol**

```bash
git add docs/architecture/frame-extraction.md
git commit -m "docs(frames): document cluster:N label-recovery passes"
```

This is a code change → release. Per `.claude/rules/workflow.md`: the final whole-branch review (Gate 1), the `qa` pass (Gate 2), a patch version bump across `package.json` / `plugin.json` / `.claude-plugin/marketplace.json` (1.0.1 → 1.0.2) + CHANGELOG, then PR to `main` with the CI gate, merge, and worktree removal — handled by the controller in the finishing flow.

---

## Self-Review

**Spec coverage:** directory-aware char rule global (T1) ✓; Pass 4.5 with generic-allowance + 0.3 salience floor + route-param/bracket/suppressed exclusion (T2) ✓; honest descriptor with no count, dir-only (T3) ✓; `cluster:N` retained as floor (T3) ✓; determinism (sorted ops throughout) ✓; Cortex target + corpus regression guard (T4) ✓; docs (T4) ✓; the global-change narrowing fallback is specified (T4 Step 3).

**Placeholder scan:** none — every code/test step carries full code and exact commands.

**Type consistency:** `isDirectorySegment(token, memberPaths)` defined T1, used T2/T3; `relaxedRecoveryLabel(topTokens, memberPaths, params, suppressedTerms)` defined+wired T2; `descriptorLabel(memberPaths)` defined+wired T3; `dominantPathSegmentLabel`'s new optional `minFraction` is backward-compatible (omitted = current behavior), consumed only by `relaxedRecoveryLabel`. `pickFrameLabel`'s public signature is unchanged.
