# Convention-Aware Tokenization + Label Salience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make frame labels name the *domain* (e.g. `activator`, `users`) instead of a framework idiom (`[orgId]`, `use*`, route methods, MVC layer markers) or a single arbitrary member file.

**Architecture:** Phase 1 of the import-aware frame-extraction design ([spec](../specs/2026-06-04-import-aware-frame-extraction-design.md) §5). Pure TypeScript, no Python/venv changes. Two cooperating changes, fed by one shared vocabulary module: (1) `path-tokenize.ts` drops/normalises structural segments so they never reach the TF-IDF blob or the labeler; (2) `pickFrameLabel` in `inject-frames.ts` gains a cross-member **salience gate** and **structural-token ineligibility**, with the existing path-prefix fallback catching clusters that have no salient domain token. The Plan-0 eval harness (`npm run eval:frames`, baseline `scripts/frame-extraction/baselines/2026-06-04.json`) is the regression bar.

**Tech Stack:** TypeScript, Vitest, better-sqlite3. Existing modules: `src/frame-extraction/{path-tokenize,text-blob,inject-frames,eval-labels}.ts`.

**Scope note — zero-frames warning deferred.** The spec (§8, §11) suggested the zero-frames warning "rides with Plan 1." Investigation of the code shows its two surfaces do **not** fit Plan 1's pure-TS/lowest-risk profile: `index_status` is produced by the C indexer (`internal/indexer/src/handlers/handlers.c`), and the viewer is frontend JS (`src/viewer/*.js`) requiring a Gate-0 visual-QA pass. Bundling either would dilute this plan's "pure TS, lowest risk, most visible label wins" focus. The warning is therefore deferred to its own micro-plan (`Plan 1b — zero-frames warning`). This plan delivers only the tokenization + label-salience work.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/frame-extraction/structural-tokens.ts` | Shared "structural-not-topical" vocabulary + helpers (`STRUCTURAL_LABEL_TOKENS`, `ROUTE_METHOD_TOKENS`, `isDynamicSegment`, `isStructuralLabelToken`, `routeParamTokens`, `pathSalience`). Leaf module — imports nothing from frame-extraction. | **Create** |
| `src/frame-extraction/path-tokenize.ts` | Tokenize a file path into `path_tokens` / `symbol_tokens`. Now also: drop bracketed/group segments, strip leading `use`, drop route-method suffixes. | **Modify** |
| `src/frame-extraction/inject-frames.ts` | `pickFrameLabel` — add salience gate + structural ineligibility to passes 1–2. | **Modify** |
| `src/frame-extraction/eval-labels.ts` | Consume the shared vocabulary instead of defining it locally (single source of truth). | **Modify** |
| `tests/frame-extraction/structural-tokens.test.ts` | Unit tests for the shared module. | **Create** |
| `tests/frame-extraction/path-tokenize.test.ts` | Add convention-aware cases; update the one `use`-prefix expectation. | **Modify** |
| `tests/frame-extraction/inject-frames.test.ts` | Add salience-gate / structural-rejection cases; existing empty-`memberPaths` tests must still pass. | **Modify** |
| `scripts/frame-extraction/baselines/2026-06-<DD>.json` | New post-Phase-1 baseline (label violations should drop sharply; CALLS/noise must not regress). | **Create (Task 4)** |

---

## Task 1: Shared structural-token vocabulary module

**Files:**
- Create: `src/frame-extraction/structural-tokens.ts`
- Create: `tests/frame-extraction/structural-tokens.test.ts`
- Modify: `src/frame-extraction/eval-labels.ts`

Rationale: `eval-labels.ts` already owns `STRUCTURAL_LABEL_TOKENS` / `isStructuralLabelToken` / `routeParamTokens`, with a comment noting they are "Shared with Phase 1's tokenizer when it lands." Phase 1 has landed, and three modules now need them (tokenizer, labeler, checker). Extract to a cycle-free leaf module so the labeler can import them without creating a cycle (`eval-labels` already imports `pickFrameLabel` from `inject-frames`).

- [ ] **Step 1: Write the failing test**

Create `tests/frame-extraction/structural-tokens.test.ts`:

```ts
// tests/frame-extraction/structural-tokens.test.ts
import { describe, it, expect } from "vitest";
import {
  STRUCTURAL_LABEL_TOKENS,
  ROUTE_METHOD_TOKENS,
  isDynamicSegment,
  isStructuralLabelToken,
  routeParamTokens,
  pathSalience,
} from "../../src/frame-extraction/structural-tokens.js";

describe("isDynamicSegment", () => {
  it("matches bracketed and grouped route segments", () => {
    expect(isDynamicSegment("[id]")).toBe(true);
    expect(isDynamicSegment("[...slug]")).toBe(true);
    expect(isDynamicSegment("[orgId]")).toBe(true);
    expect(isDynamicSegment("(marketing)")).toBe(true);
  });
  it("does not match ordinary segments", () => {
    expect(isDynamicSegment("billing")).toBe(false);
    expect(isDynamicSegment("users")).toBe(false);
  });
});

describe("isStructuralLabelToken", () => {
  it("flags MVC markers and the use prefix", () => {
    expect(isStructuralLabelToken("controller")).toBe(true);
    expect(isStructuralLabelToken("Models")).toBe(true);
    expect(isStructuralLabelToken("use")).toBe(true);
  });
  it("flags bracketed segments", () => {
    expect(isStructuralLabelToken("[id]")).toBe(true);
  });
  it("does not flag domain nouns", () => {
    expect(isStructuralLabelToken("billing")).toBe(false);
    expect(isStructuralLabelToken("user")).toBe(false); // not "use"
  });
});

describe("ROUTE_METHOD_TOKENS", () => {
  it("contains the standard HTTP verbs", () => {
    for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      expect(ROUTE_METHOD_TOKENS.has(m)).toBe(true);
    }
  });
});

describe("routeParamTokens", () => {
  it("extracts lowercased param names from member paths", () => {
    const params = routeParamTokens([
      "apps/x/pages/[orgId]/design-systems/colors.vue",
      "apps/x/pages/[orgId]/fonts.vue",
      "pages/[...slug].vue",
    ]);
    expect(params.has("orgid")).toBe(true);
    expect(params.has("slug")).toBe(true);
  });
});

describe("pathSalience", () => {
  it("is the fraction of member paths containing the token", () => {
    const paths = ["a/email.vue", "a/banners.vue", "a/slides.vue", "a/briefs.vue"];
    expect(pathSalience("email", paths)).toBeCloseTo(0.25);
    expect(pathSalience("a", paths)).toBeCloseTo(1.0);
  });
  it("returns 0 for empty member set", () => {
    expect(pathSalience("anything", [])).toBe(0);
  });
});

describe("STRUCTURAL_LABEL_TOKENS", () => {
  it("includes the use prefix and MVC singular/plural forms", () => {
    expect(STRUCTURAL_LABEL_TOKENS.has("use")).toBe(true);
    expect(STRUCTURAL_LABEL_TOKENS.has("controller")).toBe(true);
    expect(STRUCTURAL_LABEL_TOKENS.has("controllers")).toBe(true);
    expect(STRUCTURAL_LABEL_TOKENS.has("schema")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/structural-tokens.test.ts`
Expected: FAIL — cannot resolve `../../src/frame-extraction/structural-tokens.js` (module does not exist yet).

- [ ] **Step 3: Create the module**

Create `src/frame-extraction/structural-tokens.ts`:

```ts
// src/frame-extraction/structural-tokens.ts
/**
 * Structural-not-topical token vocabulary, shared by the path tokenizer,
 * the frame labeler, and the eval label-quality checker.
 *
 * A "structural" token names a file's framework ROLE — a route param, a
 * composable prefix, an HTTP method, an MVC layer marker — rather than its
 * DOMAIN. Structural tokens are dropped/normalised during tokenization and
 * are ineligible as frame labels, so a frame is named after what it is
 * ABOUT, not how the framework wires it.
 *
 * Pure leaf module: no I/O, no imports from elsewhere in frame-extraction,
 * so path-tokenize / inject-frames / eval-labels can all depend on it
 * without creating an import cycle.
 */

/** MVC / convention layer markers that must never stand alone as a label. */
export const STRUCTURAL_LABEL_TOKENS = new Set<string>([
  "use",
  "controller", "controllers", "model", "models", "view", "views",
  "serializer", "serializers", "migration", "migrations", "schema",
]);

/** HTTP method suffixes used by file-based routers (Nuxt `server/api`,
 *  SvelteKit) as a trailing dotted segment: `users.get.ts`, `auth.post.ts`. */
export const ROUTE_METHOD_TOKENS = new Set<string>([
  "get", "post", "put", "patch", "delete", "head", "options",
]);

/** True for a bracketed dynamic route segment (`[id]`, `[...slug]`) or a
 *  parenthesised route group (`(group)` in Next.js App Router). */
export function isDynamicSegment(seg: string): boolean {
  return /^\[.*\]$/.test(seg) || /^\(.*\)$/.test(seg);
}

/** True if a token is structural-not-topical: a bracketed/group segment or a
 *  member of the MVC/convention marker set. Case-insensitive. */
export function isStructuralLabelToken(token: string): boolean {
  const t = token.toLowerCase();
  if (isDynamicSegment(t)) return true;
  return STRUCTURAL_LABEL_TOKENS.has(t);
}

/** Lowercased route-param names appearing as bracketed segments in member
 *  paths. e.g. `.../[orgId]/...` -> "orgid"; `[...slug]` -> "slug". */
export function routeParamTokens(memberPaths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of memberPaths) {
    for (const seg of p.split("/")) {
      const m = seg.match(/^\[\.{0,3}(.+?)\]$/); // [x] and [...x]
      if (m) out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

/**
 * Fraction of `memberPaths` containing `token` as a (lowercased) substring.
 *
 * Used by the labeler's salience gate: a token that names < 50% of a
 * cluster's files is not representative enough to be the frame label.
 * Substring matching is intentional (cheap; a domain noun usually appears in
 * the path). Known over-match cases (e.g. "api" inside "capital") are
 * acceptable for v1 — they only ever make a token look MORE salient, never
 * less, so they cannot wrongly reject a good label.
 */
export function pathSalience(token: string, memberPaths: readonly string[]): number {
  if (memberPaths.length === 0) return 0;
  const t = token.toLowerCase();
  let hits = 0;
  for (const p of memberPaths) if (p.toLowerCase().includes(t)) hits++;
  return hits / memberPaths.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/structural-tokens.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Refactor eval-labels.ts to consume the shared module**

In `src/frame-extraction/eval-labels.ts`, replace the local definitions of
`STRUCTURAL_LABEL_TOKENS`, `isStructuralLabelToken`, `routeParamTokens`, and
the private `pathSalience` with imports from the new module, and **re-export**
the three public names so any existing importer keeps working.

Change the top of the file from:

```ts
import { pickFrameLabel } from "./inject-frames.js";
import type { ClusterAssignment } from "./types.js";

/** Structural-not-topical tokens that must never stand as a frame label.
 *  Shared with Phase 1's tokenizer when it lands. Lowercase. */
export const STRUCTURAL_LABEL_TOKENS = new Set<string>([
  "use",
  "controller", "controllers", "model", "models", "view", "views",
  "serializer", "serializers", "migration", "migrations", "schema",
]);

/** True if a token is a bracketed dynamic route segment or a structural token. */
export function isStructuralLabelToken(token: string): boolean {
  const t = token.toLowerCase();
  if (/^\[.*\]$/.test(t) || /^\(.*\)$/.test(t)) return true;
  return STRUCTURAL_LABEL_TOKENS.has(t);
}

/** Lowercased route-param names appearing as bracketed segments in paths.
 *  e.g. ".../[orgId]/..." -> "orgid", "[...slug]" -> "slug". */
export function routeParamTokens(memberPaths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of memberPaths) {
    for (const seg of p.split("/")) {
      const m = seg.match(/^\[\.{0,3}(.+?)\]$/); // [x], [...x]
      if (m) out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}
```

to:

```ts
import { pickFrameLabel } from "./inject-frames.js";
import {
  isStructuralLabelToken,
  routeParamTokens,
  pathSalience,
} from "./structural-tokens.js";
import type { ClusterAssignment } from "./types.js";

// Re-export the shared vocabulary so existing importers of eval-labels keep
// working; the single source of truth now lives in structural-tokens.ts.
export {
  STRUCTURAL_LABEL_TOKENS,
  isStructuralLabelToken,
  routeParamTokens,
} from "./structural-tokens.js";
```

Then delete the now-duplicated private `pathSalience` function further down
the file (the one with the "Known limitations" JSDoc) — `checkLabelQuality`
will use the imported `pathSalience` instead. The call site inside
`checkLabelQuality` (`pathSalience(w, c.member_paths)`) is unchanged because
the imported function has the identical signature.

- [ ] **Step 6: Run the eval-labels + structural suites to verify the refactor**

Run: `npx vitest run tests/frame-extraction/eval-labels.test.ts tests/frame-extraction/structural-tokens.test.ts`
Expected: PASS — `checkLabelQuality` behaviour is unchanged (same helpers, now imported); structural-tokens green.

- [ ] **Step 7: Commit**

```bash
git add src/frame-extraction/structural-tokens.ts \
        src/frame-extraction/eval-labels.ts \
        tests/frame-extraction/structural-tokens.test.ts
git commit -m "refactor(frames): extract shared structural-token vocabulary"
```

---

## Task 2: Convention-aware path tokenization

**Files:**
- Modify: `src/frame-extraction/path-tokenize.ts`
- Test: `tests/frame-extraction/path-tokenize.test.ts`

This feeds **both** the TF-IDF blob (`text-blob.ts` calls `tokenizePath`) and the labeler, so dropping structural noise here improves clustering and labels together. Three rules: drop bracketed/group segments entirely; strip a leading `use` prefix; drop trailing route-method suffixes.

- [ ] **Step 1: Write the failing tests**

In `tests/frame-extraction/path-tokenize.test.ts`, **update** the existing kebab-case `use` expectation and **add** a new describe block. First, change this existing test:

```ts
  it("splits kebab-case", () => {
    expect(tokenizePath("src/use-billing-state.ts").symbol_tokens).toEqual(["use", "billing", "state"]);
  });
```

to (the leading `use` convention prefix is now stripped):

```ts
  it("splits kebab-case and strips a leading use prefix", () => {
    expect(tokenizePath("src/use-billing-state.ts").symbol_tokens).toEqual(["billing", "state"]);
  });
```

Then append this new block at the end of the file:

```ts
describe("tokenizePath — convention-aware (Phase 1)", () => {
  it("drops bracketed dynamic route segments from path tokens", () => {
    const { path_tokens } = tokenizePath("apps/x/pages/[orgId]/colors.vue");
    expect(path_tokens).not.toContain("orgid");
    expect(path_tokens).toEqual(["apps", "x", "colors"]);
  });

  it("drops Next.js parenthesised route groups", () => {
    const { path_tokens } = tokenizePath("app/(marketing)/about/page.tsx");
    expect(path_tokens).not.toContain("marketing");
    expect(path_tokens).toContain("about");
  });

  it("strips a leading use prefix from composable/store filenames", () => {
    const { symbol_tokens } = tokenizePath("composables/useFoundationStore.ts");
    expect(symbol_tokens).toEqual(["foundation", "store"]);
  });

  it("does NOT strip use when it is a substring (user, useful)", () => {
    expect(tokenizePath("models/user.ts").symbol_tokens).toEqual(["user"]);
    expect(tokenizePath("lib/useful.ts").symbol_tokens).toEqual(["useful"]);
  });

  it("keeps a lone use when it is the only token", () => {
    expect(tokenizePath("lib/use.ts").symbol_tokens).toEqual(["use"]);
  });

  it("drops trailing route-method suffixes (Nuxt server/api)", () => {
    const { symbol_tokens } = tokenizePath("server/api/users.get.ts");
    expect(symbol_tokens).toEqual(["users"]);
  });

  it("contributes nothing for a fully-dynamic filename", () => {
    const t = tokenizePath("pages/users/[id].vue");
    expect(t.symbol_tokens).toEqual([]);
    expect(t.path_tokens).toEqual(["users"]);
  });

  it("does not mangle dotted bracket segments like [...slug]", () => {
    const t = tokenizePath("pages/[...slug].vue");
    expect(t.symbol_tokens).toEqual([]);
    expect(t.path_tokens).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/path-tokenize.test.ts`
Expected: FAIL — the updated kebab test and every case in the new block fail (`use` not stripped, `[orgId]`/`(marketing)` leak in, route method `get` retained, `[...slug]` mangled into `["[", "slug]"]`).

- [ ] **Step 3: Implement the tokenization changes**

In `src/frame-extraction/path-tokenize.ts`:

(a) Add the import at the top (after the existing imports):

```ts
import { isDynamicSegment, ROUTE_METHOD_TOKENS } from "./structural-tokens.js";
```

(b) Extend `stripFilename` so a trailing route-method suffix is stripped just like a role suffix. Change this line:

```ts
  const candidate = stem.slice(lastDot + 1).toLowerCase();
  if (!ROLE_SUFFIXES.has(candidate)) return stem;
```

to:

```ts
  const candidate = stem.slice(lastDot + 1).toLowerCase();
  if (!ROLE_SUFFIXES.has(candidate) && !ROUTE_METHOD_TOKENS.has(candidate)) return stem;
```

(c) Replace the body of `tokenizePath` (everything after `const merged = ...; const file = ...; const dir = ...;`) so it drops dynamic dir segments, guards a fully-dynamic filename, and strips a leading `use`. Replace from the `const dirSegments` declaration through the `return` with:

```ts
  // Path tokens: split the directory by separator, lowercase, drop strip-list
  // AND drop dynamic route segments ([id], [...slug], (group)) — these are
  // structural, never domain signal.
  const dirSegments = dir
    .split(sep)
    .map((s) => s.toLowerCase())
    .filter(
      (s) =>
        s !== "" &&
        s !== "." &&
        !STRIP_SEGMENTS.has(s) &&
        !isDynamicSegment(s),
    );

  // Tokenize the filename stem. A fully-dynamic filename ([id].vue,
  // [...slug].ts) carries no domain signal, so it contributes nothing.
  // (Guard on the RAW stem before splitWords, because splitWords treats the
  //  dots in [...slug] as separators and would shatter it into junk tokens.)
  const ext = extname(file);
  const bareStem = ext ? file.slice(0, -ext.length) : file;
  let stemWords: string[] = [];
  if (!isDynamicSegment(bareStem)) {
    const stem = stripFilename(file, merged);
    stemWords = splitWords(stem).filter((w) => !STRIP_SEGMENTS.has(w));
    // Strip a leading composable/store `use` prefix (useFoundationStore →
    // foundation store). `use` is a convention marker, not a domain noun.
    // Only when it is a distinct leading word and not the only token.
    if (stemWords.length > 1 && stemWords[0] === "use") {
      stemWords = stemWords.slice(1);
    }
  }
  const allPath = [...dirSegments.flatMap(splitWords), ...stemWords];

  // Symbol tokens: only the stripped stem words.
  return {
    path_tokens: dedupePreserveOrder(allPath),
    symbol_tokens: dedupePreserveOrder(stemWords),
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/path-tokenize.test.ts`
Expected: PASS — all original cases (the earlier `use-billing-state` now returns `["billing","state"]`) plus the new convention block.

- [ ] **Step 5: Run the text-blob suite (downstream consumer)**

Run: `npx vitest run tests/frame-extraction/text-blob.test.ts`
Expected: PASS — `collectBlobsFromGraph` seeds blobs from `tokenizePath().path_tokens`; verify the tokenization change didn't break blob construction.

- [ ] **Step 6: Commit**

```bash
git add src/frame-extraction/path-tokenize.ts tests/frame-extraction/path-tokenize.test.ts
git commit -m "feat(frames): convention-aware path tokenization (brackets, use, route methods)"
```

---

## Task 3: Label salience gate + structural ineligibility

**Files:**
- Modify: `src/frame-extraction/inject-frames.ts`
- Test: `tests/frame-extraction/inject-frames.test.ts`

`pickFrameLabel` passes 1–2 currently accept any non-generic token. Add two more eligibility conditions: the word must not be structural (route param / MVC marker / bracket), and — when member paths are available — it must appear in ≥50% of them. A non-salient leaf token (`email`, 1/7) now falls through to the existing path-prefix fallback (`activator`). The gate is **skipped when `memberPaths` is empty**, preserving the many token-only callers (and tests).

- [ ] **Step 1: Write the failing tests**

In `tests/frame-extraction/inject-frames.test.ts`, append a new describe block (do not change existing blocks — they must still pass, proving the empty-`memberPaths` path is preserved):

```ts
describe("pickFrameLabel — salience gate + structural ineligibility (Phase 1)", () => {
  const activatorPages = [
    "apps/activator/app/pages/activator/banners.vue",
    "apps/activator/app/pages/activator/briefs.vue",
    "apps/activator/app/pages/activator/email.vue",
    "apps/activator/app/pages/activator/index.vue",
    "apps/activator/app/pages/activator/presentations.vue",
    "apps/activator/app/pages/activator/slides.vue",
    "apps/activator/app/pages/activator/modular-content.vue",
  ];

  it("rejects a non-salient leaf token and falls back to the path prefix", () => {
    // 'email' names only 1/7 files → fails the >=50% gate → path-prefix → 'activator'.
    expect(pickFrameLabel(["email", "pages"], activatorPages)).toBe("activator");
  });

  it("prefers a salient domain token over a non-salient one", () => {
    // 'activator' is in 7/7 paths; 'email' in 1/7.
    expect(pickFrameLabel(["email", "activator"], activatorPages)).toBe("activator");
  });

  it("rejects a route-param token even when it is the top token", () => {
    const paths = [
      "apps/x/pages/[orgId]/design-systems/colors.vue",
      "apps/x/pages/[orgId]/design-systems/fonts.vue",
    ];
    expect(pickFrameLabel(["orgid", "design"], paths)).toBe("design");
  });

  it("rejects an MVC layer marker and picks the domain noun", () => {
    const paths = [
      "app/controllers/users_controller.rb",
      "app/controllers/users/sessions_controller.rb",
    ];
    expect(pickFrameLabel(["users controller", "controller", "users"], paths)).toBe("users");
  });

  it("rejects a bare 'use' bigram and picks the salient store token", () => {
    const paths = [
      "packages/ui/stores/colors.ts",
      "packages/ui/stores/fonts.ts",
    ];
    expect(pickFrameLabel(["use store", "store"], paths)).toBe("store");
  });

  it("does NOT gate on salience when memberPaths is empty (token-only callers)", () => {
    // Regression guard: every existing token-only call must behave as before.
    expect(pickFrameLabel(["email", "activator"], [])).toBe("email");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts -t "Phase 1"`
Expected: FAIL — current labeler returns `email` (no salience gate), `orgid`, `users controller`, `use store` for the first cases.

- [ ] **Step 3: Implement the gate**

In `src/frame-extraction/inject-frames.ts`:

(a) Add imports near the top (after the existing `import type { ClusterResult }` line):

```ts
import {
  isStructuralLabelToken,
  routeParamTokens,
  pathSalience,
} from "./structural-tokens.js";
```

(b) Add a private eligibility helper directly above `pickFrameLabel`:

```ts
/** A label word is eligible only if it is not generic, not structural
 *  (route param / MVC marker / bracket), and — when member paths are
 *  available — salient across ≥50% of them. The salience gate is skipped
 *  when `memberPaths` is empty so token-only callers behave as before. */
function isLabelEligibleWord(
  word: string,
  params: ReadonlySet<string>,
  memberPaths: readonly string[],
): boolean {
  const w = word.toLowerCase();
  if (isGenericToken(w)) return false;
  if (isStructuralLabelToken(w)) return false;
  if (params.has(w)) return false;
  if (memberPaths.length > 0 && pathSalience(w, memberPaths) < 0.5) return false;
  return true;
}
```

(c) Replace passes 1–2 of `pickFrameLabel` (the two `for` loops before the path-prefix fallback) with versions that use the helper. Change:

```ts
  // Pass 1: first bigram (or n-gram) where every word is non-generic.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 1 && parts.every((p) => !isGenericToken(p))) {
      return token;
    }
  }

  // Pass 2: first non-generic unigram.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 1 && !isGenericToken(parts[0]!)) {
      return token;
    }
  }
```

to:

```ts
  const params = routeParamTokens(memberPaths);

  // Pass 1: first n-gram where every word is label-eligible.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 1 && parts.every((p) => isLabelEligibleWord(p, params, memberPaths))) {
      return token;
    }
  }

  // Pass 2: first label-eligible unigram.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 1 && isLabelEligibleWord(parts[0]!, params, memberPaths)) {
      return token;
    }
  }
```

(Leave passes 3 and 4 — the path-prefix fallback and `cluster:<id>` — unchanged.)

- [ ] **Step 4: Run the inject-frames suite to verify it passes**

Run: `npx vitest run tests/frame-extraction/inject-frames.test.ts`
Expected: PASS — the new Phase-1 block plus every pre-existing block (empty-`memberPaths` behaviour intact, `buildFrameAssignments` / `injectFrames` unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/inject-frames.ts tests/frame-extraction/inject-frames.test.ts
git commit -m "feat(frames): salience gate + structural ineligibility in pickFrameLabel"
```

---

## Task 4: Corpus verification + re-baseline

**Files:**
- Create: `scripts/frame-extraction/baselines/2026-06-<DD>.json` (new post-Phase-1 baseline)
- (No source changes — this is the eval gate for the whole plan.)

The full TS suite is the hard, deterministic gate. The corpus eval (`npm run eval:frames`) is the broader guard; it depends on network (cloning public repos) and the Python venv, so report honestly if it cannot run here.

- [ ] **Step 1: Run the full TS suite (hard gate)**

Run: `npm test`
Expected: PASS — 0 failures. This includes `path-tokenize`, `inject-frames`, `eval-labels`, `structural-tokens`, `text-blob`, `corpus-fixtures`. If any pre-existing test pinned the old labeler output, fix it to the new (correct) label and note it in the commit.

- [ ] **Step 2: Check for any test pinning the old baseline violation count**

Run: `grep -rn "133\|2026-06-04.json" tests/ scripts/ src/`
Expected: identify whether any test asserts the old `133` label-violation count or loads `baselines/2026-06-04.json`. If a test pins `133`, it will now be wrong — Phase 1 is designed to reduce violations. Update that assertion to read the regenerated baseline (Step 4) or to assert "violations < previous baseline", and re-run `npm test`.

- [ ] **Step 3: Run the corpus eval (best-effort)**

Run: `npm run eval:frames`
Expected: writes a corpus-wide report JSON (clusters + CALLS agreement + noiseRate + label violations per repo). If clone/venv is unavailable in this environment, the runner's per-repo try/catch records the error; **report that the corpus run could not complete and flag this task as needing user-driven hand-verify before merge** (per the workflow Gate-0/2 honesty rule). Do not fabricate numbers.

- [ ] **Step 4: Compare to baseline and commit a new baseline (only if the eval ran)**

Compare the fresh report against `scripts/frame-extraction/baselines/2026-06-04.json`:
- **Label violations:** total must be **lower** than 133 (the headline Phase-1 win).
- **CALLS agreementScore:** ≥ baseline on every repo (no clustering regression).
- **noiseRate:** ≤ baseline on every repo (tokenization down-weighting must not raise noise).

If all three hold, copy the fresh report to `scripts/frame-extraction/baselines/2026-06-<DD>.json` (today's date) as the new regression bar for Phases 2–3, then commit:

```bash
git add scripts/frame-extraction/baselines/2026-06-<DD>.json tests/
git commit -m "test(frames): re-baseline after convention-aware tokenization + salience"
```

If a CALLS/noise regression appears on any repo, STOP — do not commit a regressed baseline. Return to systematic debugging (the tokenization change is the only clustering-affecting edit) before proceeding.

- [ ] **Step 5: Spot-check the two targeted wins (if the eval ran)**

In the fresh report, confirm:
- anthill-cloud's former `activator email` frame now labels to a domain (`activator`).
- No label in any repo contains a bracketed route param, a bare `use`, or a bare MVC marker.

Document the before/after for these in the commit body or a short note. (cortex's `cli commands` split is Phase 3, not expected here.)

---

## Deferred — Plan 1b: zero-frames warning

Not in this plan. Rationale (see Scope note above): the warning's surfaces are a C-backed `index_status` (`internal/indexer/src/handlers/handlers.c`) and the frontend viewer (`src/viewer/*.js`, Gate-0 visual QA). Neither matches Plan 1's pure-TS/lowest-risk profile. Track as its own micro-plan after Phase 1 lands. The detection logic ("project has file nodes but zero `frame_id`") is a single query already expressible against the graph DB; the work is in the two presentation surfaces, not the detection.

---

## Self-Review

**1. Spec coverage (§5):**
- "Drop bracketed dynamic segments entirely" → Task 2 Step 3(c) `isDynamicSegment` filter on dir + raw-stem guard. ✓
- "strip a leading use before CamelCase" → Task 2 Step 3(c) leading-`use` strip. ✓
- "drop trailing route-method tokens" → Task 2 Step 3(b) `ROUTE_METHOD_TOKENS` in `stripFilename`. ✓
- "Down-weight MVC layer markers as label-ineligible" → Task 1 `STRUCTURAL_LABEL_TOKENS` + Task 3 `isLabelEligibleWord`. (v1 = label-ineligible; clustering-weight down-weighting beyond this is not required by the acceptance and is left to Phase 2's signal work. Noted.) ✓
- "feeds both the TF-IDF blob and the labeler" → `text-blob.ts` consumes `tokenizePath` (verified in Task 2 Step 5); labeler in Task 3. ✓
- "cross-member salience gate ... ≥50% of member_paths ... falls through to path-prefix fallback" → Task 3. ✓
- "4-pass structure and path-prefix fallback retained" → Task 3 leaves passes 3–4 unchanged. ✓
- Acceptance "label-quality rules hold corpus-wide; no clustering regression" → Task 4. ✓

**2. Placeholder scan:** Only intentional placeholder is `<DD>` in the new baseline filename (today's date, resolved at execution). No TBD/TODO; every code step shows complete code. ✓

**3. Type consistency:** `pathSalience(token, memberPaths)`, `routeParamTokens(memberPaths)`, `isStructuralLabelToken(token)`, `isDynamicSegment(seg)` — same signatures used in the module (Task 1), the labeler (Task 3), and the eval-labels refactor (Task 1 Step 5). `pickFrameLabel(topTokens, memberPaths, clusterId?)` signature unchanged. `isLabelEligibleWord(word, params, memberPaths)` defined and called consistently. ✓

**Edge case verified:** empty `memberPaths` skips the salience gate (Task 3 helper) so all pre-existing token-only tests pass — explicitly asserted by the "does NOT gate on salience when memberPaths is empty" test.
