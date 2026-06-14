# Sibling Auto-Index Hook (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `prefer-cortex.sh` key its index gate on the **search target** repo (not the cwd repo), and when a code search targets an unindexed high-certainty git sibling, background-index it and allow the grep.

**Architecture:** Shell. Resolve the search target per tool (`tool_input.path` for Grep/Glob; first path-like token for Bash; cwd otherwise) → its git root. If that root is indexed → existing redirect. If unindexed + high-certainty (real git root, not denylisted) → fire a detached `cortex index` (deduped by a TTL sentinel, logged, degrade-safe) and allow. Everything else → allow. Gated by `CORTEX_AUTO_INDEX` (default on).

**Tech Stack:** Bash (degrade-safe, `set +e`, `jq`), vitest for the hook tests (spawns the script via `execFileSync`).

Design: [docs/superpowers/specs/2026-06-14-context-pack-and-sibling-auto-index-design.md](../specs/2026-06-14-context-pack-and-sibling-auto-index-design.md) (§P3).

> **NOTE — test safety:** the existing hook tests build unindexed repos *with* a `.git` dir, which this change makes "high-certainty." Every hook test that hits an unindexed git repo MUST set either `CORTEX_AUTO_INDEX=0` or `CORTEX_BIN=<stub>` so a real `cortex index` never spawns during the suite. Tasks 4–5 do this.

---

### Task 1: Make the index gate target-aware (no auto-index yet)

**Files:**
- Modify: `hooks/prefer-cortex.sh`

This task ONLY moves the gate from cwd to target. Auto-index is Task 3. Splitting keeps the bug fix (sibling grep no longer wrongly denied) independently verifiable.

- [ ] **Step 1: Write failing tests for target-aware gating**

Add to `tests/hooks/prefer-cortex.test.ts` a new describe block. It needs a second indexed repo and helpers that pass an explicit `path` / command targeting another repo:

```ts
describe("prefer-cortex.sh — target-repo-aware gate", () => {
  it("ALLOWS a code Grep whose path targets an UNINDEXED sibling (cwd is indexed)", () => {
    const cwd = indexedRepo();
    const sibling = unindexedRepo();
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({
        tool_name: "Grep",
        cwd,
        tool_input: { pattern: "foo", type: "ts", path: sibling },
      }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_AUTO_INDEX: "0" }, // no spawn in this task's test
    }).trim();
    expect(out).toBe("");
  });

  it("DENIES a code Grep whose path targets a SECOND indexed repo", () => {
    const cwd = unindexedRepo();
    const target = indexedRepo();
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({
        tool_name: "Grep",
        cwd,
        tool_input: { pattern: "foo", type: "ts", path: target },
      }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_AUTO_INDEX: "0" },
    }).trim();
    const parsed = out === "" ? null : JSON.parse(out);
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("ALLOWS a Bash code grep targeting an unindexed sibling by path arg", () => {
    const cwd = indexedRepo();
    const sibling = unindexedRepo();
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({
        tool_name: "Bash",
        cwd,
        tool_input: { command: `rg foo ${sibling}/src` },
      }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_AUTO_INDEX: "0" },
    }).trim();
    expect(out).toBe("");
  });
});
```

- [ ] **Step 2: Run them — expect FAIL**

Run: `npx vitest run tests/hooks/prefer-cortex.test.ts -t "target-repo-aware"`
Expected: FAIL — the current gate anchors on cwd, so the sibling cases deny (wrong) / the second-indexed-repo case allows (wrong).

- [ ] **Step 3: Add target-resolution helpers + replace the cwd gate**

In `hooks/prefer-cortex.sh`, after the `case "$TOOL" in Grep|Glob|Bash) ;; *) exit 0 ;; esac` block (currently ~line 42) and BEFORE the current index gate (lines 49-58), insert these helpers:

```bash
# --- Target resolution -------------------------------------------------------
# Resolve a path arg (absolute / ~ / relative-to-cwd; file or dir) to its git
# root, printed on stdout. Returns non-zero (prints nothing) when the path
# doesn't exist or isn't in a git repo.
git_root_of() {
  local p="$1"
  case "$p" in
    /*) ;;
    "~"/*) p="$HOME/${p#\~/}" ;;
    *) p="$CWD/$p" ;;
  esac
  local dir="$p"
  [ -f "$dir" ] && dir="$(dirname "$dir")"
  [ -d "$dir" ] || return 1
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null
}

# `-s`: exists AND non-empty, so a 0-byte degraded DB reads as not-indexed.
repo_indexed() { [ -s "$1/.cortex/db" ] || [ -s "$1/.cortex/graph.db" ]; }

# First path-like token in a Bash command: starts with / ./ ../ ~ or contains
# a slash; not a -flag; not an =assignment. Quoted literals already stripped by
# the caller. Prints the first match (empty if none).
first_path_token() {
  local tok
  for tok in $1; do
    case "$tok" in
      -*) continue ;;        # flag
      *=*) continue ;;       # env assignment / --opt=val
      /*|./*|../*|"~"/*) printf '%s' "$tok"; return 0 ;;
      */*) printf '%s' "$tok"; return 0 ;;
    esac
  done
  return 0
}
```

Then REPLACE the existing index gate (the `indexed=0 … [ "$indexed" = "1" ] || exit 0` block, ~lines 49-58) with target resolution:

```bash
# Resolve the SEARCH TARGET (not necessarily the cwd) and its git root.
TARGET_PATH=""
case "$TOOL" in
  Grep|Glob)
    TARGET_PATH="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.path // empty' 2>/dev/null)"
    ;;
  Bash)
    _CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)"
    _CMD_STRIPPED="$(printf '%s' "$_CMD" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")"
    TARGET_PATH="$(first_path_token "$_CMD_STRIPPED")"
    ;;
esac

TARGET_ROOT=""
if [ -n "$TARGET_PATH" ]; then
  TARGET_ROOT="$(git_root_of "$TARGET_PATH")"
fi
# Bare pattern (no path arg) or unresolvable target → fall back to cwd's root.
if [ -z "$TARGET_ROOT" ]; then
  TARGET_ROOT="$(git_root_of "$CWD")"
fi

# Index gate, now anchored to the TARGET repo. Unindexed → Cortex can't answer
# (yet) → fall through to the per-tool branch, which allows (Task 3 adds the
# background-index side effect here).
if [ -n "$TARGET_ROOT" ] && repo_indexed "$TARGET_ROOT"; then
  indexed=1
else
  indexed=0
fi
[ "$indexed" = "1" ] || exit 0
```

- [ ] **Step 4: Run the target-aware tests — expect PASS**

Run: `npx vitest run tests/hooks/prefer-cortex.test.ts -t "target-repo-aware"`
Expected: PASS.

- [ ] **Step 5: Run the FULL hook suite — expect PASS (no regressions)**

Run: `npx vitest run tests/hooks/prefer-cortex.test.ts`
Expected: PASS. The existing "allows everything on an unindexed repo" test (cwd unindexed, no path arg) still allows because `TARGET_ROOT` falls back to the unindexed cwd → `indexed=0` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add hooks/prefer-cortex.sh tests/hooks/prefer-cortex.test.ts
git commit -m "fix(hooks): gate prefer-cortex on the search target repo, not cwd (P3)"
```

---

### Task 2: Verify detached-process survival on macOS (Gate 0 — manual)

**Files:** none (verification only — but its outcome may change Task 3's spawn recipe).

This is the one genuinely uncertain piece. Do it BEFORE writing Task 3's spawn so the recipe is proven.

- [ ] **Step 1: Write a throwaway probe script**

```bash
cat > /tmp/cortex-detach-probe.sh <<'EOF'
#!/usr/bin/env bash
set +e
ROOT="$1"
nohup sh -c 'sleep 2; echo done > "'"$ROOT"'/.probe-done"' >/tmp/probe.log 2>&1 </dev/null &
disown 2>/dev/null || true
echo "hook exiting now"
EOF
chmod +x /tmp/cortex-detach-probe.sh
mkdir -p /tmp/probe-root && rm -f /tmp/probe-root/.probe-done
/tmp/cortex-detach-probe.sh /tmp/probe-root
```

- [ ] **Step 2: Confirm the child survived the parent exit**

Wait ~3 seconds, then run: `cat /tmp/probe-root/.probe-done`
Expected: prints `done` — the child kept running after the script exited.

- [ ] **Step 3: If it did NOT survive, switch to the double-fork recipe**

If `.probe-done` is absent, the working recipe is a double-fork subshell instead of `nohup … & disown`:

```bash
( setsid_cmd() { "$@"; }; ( nohup sh -c '…' >log 2>&1 </dev/null & ) )
```

Concretely, the survivable form on macOS is wrapping the spawn in its own subshell so the job is reparented to init:

```bash
( nohup "$bin" index repository --path="$root" >"$log" 2>&1 </dev/null & )
```

Record which recipe verified, and use THAT exact form in Task 3 Step 2. (The plan's Task 3 uses the `( … & )` subshell form, which is the more robust of the two on macOS.)

---

### Task 3: Background-index unindexed high-certainty siblings, then allow

**Files:**
- Modify: `hooks/prefer-cortex.sh`

- [ ] **Step 1: Write failing tests using a stubbed `cortex`**

Add a describe block to `tests/hooks/prefer-cortex.test.ts`. The stub is a script that writes a marker file; the hook should spawn it (detached), so the test polls for the marker.

```ts
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
// (mkdtempSync/mkdirSync/writeFileSync already imported at top; add existsSync, chmodSync)

/** A fake `cortex` CLI that touches $CORTEX_TEST_MARKER and exits 0. */
function stubCortex(markerPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cortex-stub-"));
  const bin = join(dir, "cortex");
  writeFileSync(bin, `#!/bin/sh\ntouch "${markerPath}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Poll for a file up to timeoutMs (detached spawn is async). */
function waitForFile(p: string, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return true;
    // busy-wait via a tiny sync sleep
    execFileSync("sleep", ["0.05"]);
  }
  return existsSync(p);
}

describe("prefer-cortex.sh — sibling auto-index", () => {
  it("background-indexes an unindexed high-certainty git sibling, then allows", () => {
    const cwd = indexedRepo();
    const sibling = unindexedRepo(); // real git root, no .cortex/db
    const marker = join(sibling, ".index-fired");
    const bin = stubCortex(marker);
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({
        tool_name: "Grep",
        cwd,
        tool_input: { pattern: "foo", type: "ts", path: sibling },
      }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_BIN: bin, CORTEX_AUTO_INDEX: "1" },
    }).trim();
    expect(out).toBe(""); // allowed
    expect(waitForFile(marker)).toBe(true); // index spawned
    expect(existsSync(join(sibling, ".cortex", ".auto-index-attempted"))).toBe(true);
  });

  it("does NOT spawn for a denylisted target (node_modules)", () => {
    const cwd = indexedRepo();
    const base = unindexedRepo();
    const nm = join(base, "node_modules", "pkg");
    mkdirSync(nm, { recursive: true });
    mkdirSync(join(nm, ".git"), { recursive: true });
    const marker = join(base, ".should-not-fire");
    const bin = stubCortex(marker);
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Grep", cwd, tool_input: { pattern: "foo", type: "ts", path: nm } }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_BIN: bin, CORTEX_AUTO_INDEX: "1" },
    }).trim();
    expect(out).toBe(""); // still allowed
    expect(waitForFile(marker, 600)).toBe(false); // no spawn
  });

  it("does NOT spawn when CORTEX_AUTO_INDEX=0", () => {
    const cwd = indexedRepo();
    const sibling = unindexedRepo();
    const marker = join(sibling, ".should-not-fire");
    const bin = stubCortex(marker);
    execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Grep", cwd, tool_input: { pattern: "foo", type: "ts", path: sibling } }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_BIN: bin, CORTEX_AUTO_INDEX: "0" },
    });
    expect(waitForFile(marker, 600)).toBe(false);
  });

  it("does NOT spawn when the sentinel is fresh", () => {
    const cwd = indexedRepo();
    const sibling = unindexedRepo();
    mkdirSync(join(sibling, ".cortex"), { recursive: true });
    writeFileSync(join(sibling, ".cortex", ".auto-index-attempted"), ""); // fresh
    const marker = join(sibling, ".should-not-fire");
    const bin = stubCortex(marker);
    execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Grep", cwd, tool_input: { pattern: "foo", type: "ts", path: sibling } }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_BIN: bin, CORTEX_AUTO_INDEX: "1" },
    });
    expect(waitForFile(marker, 600)).toBe(false);
  });

  it("does NOT spawn when no cortex CLI is resolvable (degrade-safe allow)", () => {
    const cwd = indexedRepo();
    const sibling = unindexedRepo();
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Grep", cwd, tool_input: { pattern: "foo", type: "ts", path: sibling } }),
      encoding: "utf-8",
      // CORTEX_BIN unset + PATH without cortex → unresolvable. Still allows.
      env: { ...process.env, CORTEX_BIN: "", CORTEX_AUTO_INDEX: "1", PATH: "/usr/bin:/bin" },
    }).trim();
    expect(out).toBe("");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (no spawn logic yet)**

Run: `npx vitest run tests/hooks/prefer-cortex.test.ts -t "sibling auto-index"`
Expected: FAIL — the marker is never written; sentinel never created.

- [ ] **Step 3: Add the `maybe_bg_index` helper + call it on the unindexed path**

In `hooks/prefer-cortex.sh`, add this helper alongside the others from Task 1:

```bash
# Denylist: never auto-index junk/vendored/tmp trees.
AUTO_INDEX_DENYLIST_RE='(^|/)(\.tmp|tmp|node_modules|vendor|dist|build|\.cache)(/|$)'

# Best-effort detached index of an unindexed, high-certainty git root.
# Degrade-safe: any failure simply skips indexing — the grep is already allowed.
maybe_bg_index() {
  local root="$1"
  [ -n "$root" ] || return 0
  [ "${CORTEX_AUTO_INDEX:-1}" = "0" ] && return 0
  printf '%s' "$root" | grep -Eq "$AUTO_INDEX_DENYLIST_RE" && return 0

  local bin="${CORTEX_BIN:-}"
  [ -n "$bin" ] || bin="$(command -v cortex 2>/dev/null)"
  [ -n "$bin" ] || return 0

  local sentinel="$root/.cortex/.auto-index-attempted"
  if [ -f "$sentinel" ] && [ -z "$(find "$sentinel" -mmin +60 2>/dev/null)" ]; then
    return 0   # fresh attempt (<60 min) — skip
  fi
  mkdir -p "$root/.cortex" 2>/dev/null || return 0
  : > "$sentinel" 2>/dev/null || true

  local log="$root/.cortex/auto-index.log"
  # Detached subshell so the index survives this hook's exit (verified recipe
  # from the Gate 0 detachment probe). cortex CLI form per RepoNotIndexedError.
  ( nohup "$bin" index repository --path="$root" >"$log" 2>&1 </dev/null & ) 2>/dev/null || true
  return 0
}
```

Now change the index gate's unindexed branch so that, instead of bare `exit 0`, it tries the background index first. Replace:

```bash
if [ -n "$TARGET_ROOT" ] && repo_indexed "$TARGET_ROOT"; then
  indexed=1
else
  indexed=0
fi
[ "$indexed" = "1" ] || exit 0
```

with:

```bash
if [ -n "$TARGET_ROOT" ] && repo_indexed "$TARGET_ROOT"; then
  indexed=1
else
  # Unindexed target. If it's a real git root (high-certainty), kick off a
  # detached index for next time. Either way, allow the grep now.
  if [ -n "$TARGET_ROOT" ]; then maybe_bg_index "$TARGET_ROOT"; fi
  exit 0
fi
```

(Note: `maybe_bg_index` fires regardless of code-vs-non-code scope — indexing the sibling helps all future queries, and we only reach here when Cortex couldn't answer anyway. The high-certainty gate inside the helper is what prevents junk indexing.)

- [ ] **Step 4: Run the sibling-auto-index tests — expect PASS**

Run: `npx vitest run tests/hooks/prefer-cortex.test.ts -t "sibling auto-index"`
Expected: PASS (all five cases).

- [ ] **Step 5: Run the FULL hook suite — expect PASS**

Run: `npx vitest run tests/hooks/prefer-cortex.test.ts`
Expected: PASS. (The pre-existing "allows everything on an unindexed repo" test at the bottom of the file does NOT set `CORTEX_BIN`/`CORTEX_AUTO_INDEX`; with a real `cortex` possibly on PATH it could now spawn an index against a tmp repo. **Update that test** to add `env: { ...process.env, CORTEX_AUTO_INDEX: "0" }` to its `run`/`execFileSync` calls so the suite never triggers real indexing.)

To update the existing test, change its body to call the hook with `CORTEX_AUTO_INDEX=0`:

```ts
  it("allows everything on an unindexed repo (Cortex can't answer)", () => {
    const repo = unindexedRepo();
    const call = (tool_input: object, tool_name = "Grep") =>
      execFileSync("bash", [HOOK], {
        input: JSON.stringify({ tool_name, cwd: repo, tool_input }),
        encoding: "utf-8",
        env: { ...process.env, CORTEX_AUTO_INDEX: "0" },
      }).trim();
    expect(call({ pattern: "foo" })).toBe("");
    expect(call({ command: "rg foo src/" }, "Bash")).toBe("");
  });
```

- [ ] **Step 6: Commit**

```bash
git add hooks/prefer-cortex.sh tests/hooks/prefer-cortex.test.ts
git commit -m "feat(hooks): background-index unindexed high-certainty siblings (P3)"
```

---

### Task 4: Docs + decision capture

**Files:**
- Modify: `CLAUDE.md` (prefer-cortex section)

- [ ] **Step 1: Update the CLAUDE.md prefer-cortex description**

In the "This routing is hook-enforced" section, document: (a) the gate now keys on the **search target** repo, so a grep against an unindexed sibling is allowed (not denied by the cwd's index); (b) a code search against an unindexed high-certainty git sibling triggers a **detached background index** of that sibling (deduped, logged to `<root>/.cortex/auto-index.log`, disabled with `CORTEX_AUTO_INDEX=0`). Note the denylist (`.tmp`, `tmp`, `node_modules`, `vendor`, `dist`, `build`, `.cache`) and `CORTEX_BIN` override.

- [ ] **Step 2: Capture the decision (this repo is indexed)**

```
search_decisions({ repo_path: "<this repo>", query: "prefer-cortex hook target repo auto-index sibling" })
create_decision({
  repo_path: "<this repo>",
  title: "prefer-cortex hook is target-aware and background-indexes siblings",
  description: "The grep-redirect hook gates on the search TARGET repo's index (not cwd), and fires a detached cortex index for unindexed high-certainty git siblings before allowing the grep.",
  rationale: "Fixes wrongly-denied greps against unindexed siblings; turns 'Cortex can't answer here' into 'make it able to' at the point of need, compounding index coverage. Detached + deduped + denylisted + gated keeps the hook fast and degrade-safe.",
  alternatives: "Passive allow + nudge (rejected: wastes the moment); synchronous in-hook index (rejected: latency/timeout/degrade-safety); deny-and-instruct-agent (rejected by product owner in favor of zero-friction background indexing).",
  governs: ["hooks/prefer-cortex.sh"]
})
link_decision({ repo_path: "<this repo>", decision_id: "<new id>", target: "hooks/prefer-cortex.sh", relation: "GOVERNS" })
```

- [ ] **Step 3: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: target-aware + sibling auto-index prefer-cortex hook (P3)"
```

---

## Self-Review

**Spec coverage:** target resolution per tool (Task 1 `git_root_of`/`first_path_token` + the per-tool TARGET_PATH switch) ✓; gate on target's index (Task 1) ✓; indexed-second-repo still redirects (Task 1 test) ✓; high-certainty gate = git root + denylist (Task 3 `maybe_bg_index`) ✓; detached spawn + sentinel TTL + log + CORTEX_BIN resolution + degrade-safe (Task 3) ✓; macOS detachment proven (Task 2) ✓; `CORTEX_AUTO_INDEX` opt-out (Task 3) ✓; tests incl. no-spawn cases + CLI-missing (Task 3) ✓; docs + decision (Task 4) ✓.

**Placeholder scan:** Task 2 Step 3 leaves the spawn recipe contingent on the probe outcome but specifies the exact `( … & )` form to use and which Task 3 already adopts — not a TODO. No other placeholders.

**Type consistency (shell):** `git_root_of`, `repo_indexed`, `first_path_token`, `maybe_bg_index` are defined once and called with the documented args. `TARGET_ROOT`/`TARGET_PATH`/`indexed` are the only new vars; the existing per-tool branches (Grep/Glob/Bash scope detection + `emit_deny`) are untouched and still reached only when `indexed=1`. Sentinel path `<root>/.cortex/.auto-index-attempted` is identical in the helper and the tests.
