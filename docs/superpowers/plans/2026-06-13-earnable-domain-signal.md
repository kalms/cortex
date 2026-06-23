# Earnable Domain Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frame-layer `domain` layer *earnable* via a positive signal in the classifier's currently-silent middle topological band, so domain stops being a pure fallback before the enable slice multiplies it by the highest kind-weight.

**Architecture:** One addition to Source A (graph position) in `classifyOne`: in the middle sink band (`SINK_SURFACE < sink < SINK_SUBSTRATE`), add `W_DOMAIN_RUNTIME × runtimeFrac` to the domain contribution, where `runtimeFrac` is the fraction of members that are neither tests nor non-runtime files. `W_DOMAIN_RUNTIME = 0.5` sits below `W_PATH = 0.8`, so a typed frame always outranks it and domain only claims the untyped mid-band case. No change to the `fallback` mechanism — earned domain clears `MIN_SIGNAL` for free.

**Tech Stack:** TypeScript, Vitest, the running viewer (`npm run dev`) + Playwright for Gate 0.

Spec: [docs/superpowers/specs/2026-06-13-earnable-domain-signal-design.md](../specs/2026-06-13-earnable-domain-signal-design.md)

---

### Task 1: Positive mid-band domain signal

**Files:**
- Modify: `src/frame-extraction/frame-kind.ts` (constants block ~line 66–82; Source A block ~line 149–160)
- Test: `tests/frame-extraction/frame-kind.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `tests/frame-extraction/frame-kind.test.ts` (uses the existing `input()` helper):

```typescript
describe("positive mid-band domain signal", () => {
  it("mid-band runtime frame with no layer tokens EARNS domain (not fallback)", () => {
    // sink 0.5 (middle band), members are runtime .ts with no PATH_LAYER_TABLE
    // token → domain = W_DOMAIN_RUNTIME(0.5) × runtimeFrac(1.0) = 0.5 ≥ MIN_SIGNAL.
    const [r] = classifyFramesInternal([
      input({ frame_id: 40, fanIn: 5, fanOut: 5, member_paths: ["src/foo/alpha.ts", "src/foo/beta.ts"] }),
    ]);
    expect(r.layer).toBe("domain");
    expect(r.fallback).toBe(false);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("does NOT override a typed mid-band frame (W_DOMAIN_RUNTIME < W_PATH)", () => {
    // 'store' → data token at W_PATH(0.8); domain residual only 0.5 → data wins.
    const [r] = classifyFrames([
      input({ frame_id: 41, fanIn: 5, fanOut: 5, member_paths: ["src/store/alpha.ts", "src/store/beta.ts"] }),
    ]);
    expect(r.layer).toBe("data");
  });

  it("a mostly-test mid-band frame stays fallback (runtime signal below MIN_SIGNAL)", () => {
    // 3 tests + 1 runtime → runtimeFrac 0.25 → domain 0.125 < 0.4; testFrac 0.75 < 0.8 → no ceremony.
    const [r] = classifyFramesInternal([
      input({
        frame_id: 42, fanIn: 5, fanOut: 5,
        member_paths: ["a/w.test.ts", "a/x.test.ts", "a/y.test.ts", "a/z.ts"],
      }),
    ]);
    expect(r.layer).toBe("domain");
    expect(r.fallback).toBe(true);
  });

  it("does NOT fire outside the middle band — a substrate frame gets no domain contribution", () => {
    // sink 0.8 ≥ SINK_SUBSTRATE → substrate branch only; domain contribution stays 0.
    const [r] = classifyFramesInternal([
      input({ frame_id: 43, fanIn: 8, fanOut: 2, member_paths: ["src/foo/alpha.ts", "src/foo/beta.ts"] }),
    ]);
    expect(r.contributions.domain).toBe(0);
    expect(r.layer).toBe("data");
  });

  it("an empty-member mid-band frame is still a fallback (guarded on members.length)", () => {
    const [r] = classifyFramesInternal([input({ frame_id: 44, fanIn: 5, fanOut: 5 })]);
    expect(r.layer).toBe("domain");
    expect(r.fallback).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/frame-kind.test.ts -t "positive mid-band domain signal"`
Expected: FAIL — the "EARNS domain" test reports `fallback: true` (no signal yet); the "mostly-test" and "empty-member" tests pass already; "does NOT override" passes already; "substrate" passes already. The key failing assertion is `expect(r.fallback).toBe(false)` on frame 40.

- [ ] **Step 3: Add the constant**

In `src/frame-extraction/frame-kind.ts`, after the `MIN_SIGNAL` / `TEST_FRACTION_MIN` / `EXT_FRACTION_MIN` constants (around line 77–82), add:

```typescript
/** 0.5: domain as the positive residual in the otherwise-silent middle sink
 *  band. Below W_PATH (0.8) so a typed frame (Source B) always outranks it —
 *  domain only takes the untyped case. 0.5 × 0.8 = MIN_SIGNAL, so the bar to
 *  EARN domain is ~80% runtime content in a mid-band, untyped frame. Converts
 *  the former silent→fallback into an earned signal for genuine domain frames;
 *  test-/tooling-heavy frames stay below threshold (fallback or ceremony). */
const W_DOMAIN_RUNTIME = 0.5;
```

- [ ] **Step 4: Add the middle-band branch**

In `src/frame-extraction/frame-kind.ts`, extend the Source A `if/else if` (currently ending at the substrate branch, ~line 156–160) with a middle-band branch:

```typescript
  if (sink <= SINK_SURFACE) {
    const s = (0.5 - sink) * 2 * W_GRAPH;
    c.interface += s;
    c.orchestration += s;
  } else if (sink >= SINK_SUBSTRATE) {
    const s = (sink - 0.5) * 2 * W_GRAPH;
    c.data += s;
    c.infrastructure += s;
  } else if (members.length > 0) {
    // Middle band — was silent. Domain is the positive residual: runtime code
    // between surface and substrate with no layer-specific signal of its own.
    const runtimeFrac =
      members.filter((p) => !TEST_PATH_RE.test(p) && !NON_RUNTIME_EXT_RE.test(p)).length /
      members.length;
    c.domain += W_DOMAIN_RUNTIME * runtimeFrac;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/frame-kind.test.ts`
Expected: PASS (all, including the new block and the pre-existing tests — the "is silent in the middle band" test still passes because its frame has no members).

- [ ] **Step 6: Run the full frame-extraction suite for regressions**

Run: `npx vitest run tests/frame-extraction/`
Expected: PASS. If `expected-layers.test.ts` fails, it means a fixture frame's earned-domain reclassification fell outside its `anyOf` — note which, do not edit yet (Task 2 regenerates and relabels).

- [ ] **Step 7: Commit**

```bash
git add src/frame-extraction/frame-kind.ts tests/frame-extraction/frame-kind.test.ts
git commit -m "feat(frame-kind): earnable domain signal in the middle sink band

Runtime content in the silent middle topological band now positively earns
domain (W_DOMAIN_RUNTIME=0.5, below W_PATH so it never overrides a typed
frame). Converts fallback-domain into earned-domain for genuine mid-band
runtime frames; test-/tooling-heavy frames stay fallback. Spec:
docs/superpowers/specs/2026-06-13-earnable-domain-signal-design.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Regenerate the regression fixture against the live graph

**Files:**
- Modify: `tests/fixtures/frame-layers/cortex-frames.json` (regenerated)
- Modify (only if the coverage guard fails): `tests/frame-extraction/expected-layers.test.ts`

**Precondition:** a viewer server must be serving the current graph. If none is up:
```bash
(sleep 3600 | npm run dev > .tmp/dev-server.log 2>&1 &) ; sleep 5
curl -s -m 3 localhost:3334/viewer -o /dev/null -w "viewer: %{http_code}\n"   # expect 200
```
The dump script reads `CORTEX_API` (default `http://localhost:3333`); for the dev server pass `CORTEX_API=http://localhost:3334`.

- [ ] **Step 1: Regenerate the fixture**

Run:
```bash
CORTEX_API=http://localhost:3334 npx tsx scripts/frame-extraction/dump-frame-kind-inputs.ts \
  > tests/fixtures/frame-layers/cortex-frames.json
```
Expected: a JSON array of frame inputs (17 frames on the current cortex graph).

- [ ] **Step 2: Run the layer regression test + read the agreement report**

Run: `npx vitest run tests/frame-extraction/expected-layers.test.ts`
Expected: PASS. The console agreement report should now show **fewer `(fallback)`** annotations than before (e.g. the 7-member `frame-extraction` split flips to `domain` without `(fallback)`).

- [ ] **Step 3: Resolve any coverage-guard failure**

If "every named frame in the fixture has a hand label" fails, a new named frame appeared. Read its members:
```bash
node -e 'const f=require("./tests/fixtures/frame-layers/cortex-frames.json"); const fr=f.find(x=>x.frame_label==="<LABEL>"); fr.member_paths.forEach(p=>console.log(p));'
```
Add an `EXPECTED["<label>"] = { anyOf: [...] }` entry to `tests/frame-extraction/expected-layers.test.ts` with a one-line justification, per the in-file judgment rules. If an existing frame's earned-domain verdict falls outside its `anyOf`, widen the `anyOf` with a justification comment (the observe phase decides contested frames). Re-run Step 2 until green.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/frame-layers/cortex-frames.json tests/frame-extraction/expected-layers.test.ts
git commit -m "test(frame-layers): regen fixture with earned-domain assignments

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Gate 0 visual QA

**Files:** none (verification only). Screenshots go to `.playwright-mcp/` (gitignored).

- [ ] **Step 1: Ensure the dev server is current**

The viewer derives `layer` at read time, so a running dev server already serves the new classification (no reindex). Confirm:
```bash
curl -s -m 5 localhost:3334/api/frames | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const {frames}=JSON.parse(d);const dist={};frames.forEach(f=>dist[f.layer]=(dist[f.layer]||0)+1);console.log("layer distribution:",JSON.stringify(dist));})'
```
Expected: `domain` count > 0 with at least one *non-fallback* domain frame (e.g. `frame-extraction`). Compare to the pre-change distribution recorded in HANDOFF (domain was all-fallback).

- [ ] **Step 2: Drive the viewer with Playwright**

- Navigate to `http://localhost:3334/viewer`.
- Open the `layers` menu (`#layers-toggle`), ensure the switch is on.
- Screenshot to `.playwright-mcp/domain-signal-layers-on.png`.
- Confirm: the reclassified frames (`frame-extraction`, any newly-earned domain frame) render in domain ochre `rgb(234,186,95)`, not the previous default tint.
- Toggle the switch off; confirm zero tinted pixels (off-state pixel-identical) via canvas `getImageData` against the palette set.
- Check `browser_console_messages` (error level): expect 0 app errors.

- [ ] **Step 3: Record the outcome**

If runtime errors or a visible regression appear, stop and fix before proceeding. If the reclassification looks wrong to the eye (a frame that is clearly not domain now reads ochre), capture it — that is observe-phase signal feeding a constant tweak, not necessarily a blocker.

No commit (verification only).

---

### Task 4: Decision capture + HANDOFF update

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Capture the decision**

```
search_decisions({ query: "domain layer signal fallback weight", repo_path: "/Users/rka/Development/cortex" })
create_decision({
  repo_path: "/Users/rka/Development/cortex",
  title: "Earnable domain via positive mid-band runtime signal",
  description: "Runtime content in the silent middle sink band positively earns domain at W_DOMAIN_RUNTIME=0.5; earned vs fallback domain are distinct (1.00 / 0.50 kind-weight for the enable slice).",
  rationale: "Domain was only ever reached by fallback on real graphs yet carries the enable slice's highest kind-weight. A positive residual signal below W_PATH makes domain earnable without overriding typed frames; the fallback flag (0.8.7) keeps the residual distinct so the enable slice can down-weight it.",
  alternatives: [
    { name: "Demote fallback-domain weight only", reason_rejected: "Concedes domain is undetectable; leaves the layer meaningless." },
    { name: "Louvain feature-community concern axis", reason_rejected: "Catches substrate-band core domain too, but requires reviving dead ctx_louvain + wiring community detection; deferred (walk before run)." }
  ],
  governs: ["src/frame-extraction/frame-kind.ts"]
})
link_decision({ decision_id: "<new id>", target: "D-qn7z", relation: "RELATED_TO", repo_path: "/Users/rka/Development/cortex" })
```

- [ ] **Step 2: Update HANDOFF.md**

Mark next-step #2 (the domain question) as resolved with a one-line pointer to the spec + decision id, and note that step 3 (enable slice) is now unblocked — earned domain 1.00, fallback domain 0.50, wire kind-weight + layer-diversity behind `CORTEX_KIND_WEIGHT=1`.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "docs(handoff): domain question resolved; enable slice unblocked

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Gate 2 + merge (user-gated)

Do **not** run without explicit user approval to merge (per workflow rules).

- [ ] **Step 1: Full suite** — `npm test` → expect all green.
- [ ] **Step 2: Merge protocol** — `git checkout main && git merge --no-ff feature/component/domain-earnable-signal`, bump `package.json` / `plugin.json` / `.claude-plugin/marketplace.json` to the next patch (0.8.8), add a `CHANGELOG.md` entry + version link, commit `chore(release): 0.8.8`, delete the branch.
- [ ] **Step 3: Push** — only when the user explicitly asks.
