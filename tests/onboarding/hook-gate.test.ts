import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Absolute hook path — resolved once, before any cwd juggling. vitest runs
// with process.cwd() at the worktree root.
const HOOK = resolve(process.cwd(), "hooks/check-index.sh");

const FAKE_CORTEX = `#!/usr/bin/env bash
case "$1 $2 $3" in
  "code arch --headline") echo "HEADLINE_MARKER" ;;
  "freshness "*|"freshness") echo "fresh" ;;
  "decision count"*) echo "5" ;;
  *) : ;;
esac
`;

const tempRepos: string[] = [];

function makeRepo(indexed: boolean): string {
  const repo = mkdtempSync(join(tmpdir(), "cortex-hook-"));
  tempRepos.push(repo);
  if (indexed) {
    mkdirSync(join(repo, ".cortex"), { recursive: true });
    writeFileSync(join(repo, ".cortex", "db"), "x");
    mkdirSync(join(repo, "bin"), { recursive: true });
    const binPath = join(repo, "bin", "cortex");
    writeFileSync(binPath, FAKE_CORTEX);
    chmodSync(binPath, 0o755);
  }
  return repo;
}

function runHook(repo: string, input: object, envOverrides: Record<string, string> = {}): string {
  return execFileSync("bash", [HOOK], {
    input: JSON.stringify(input),
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      CORTEX_AUTO_REFRESH: "0",
      CORTEX_BRIEF: "1",
      CORTEX_ONBOARD: "1",
      ...envOverrides,
    },
  });
}

afterEach(() => {
  while (tempRepos.length) {
    const repo = tempRepos.pop()!;
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("check-index onboarding sentinel gate", () => {
  it("emits the headline on first session and writes the sentinel", () => {
    const repo = makeRepo(true);
    const out = runHook(repo, { session_id: "s1", source: "startup", cwd: repo });

    expect(out).toContain("HEADLINE_MARKER");

    const orientFile = join(repo, ".cortex", ".oriented");
    expect(existsSync(orientFile)).toBe(true);
    expect(readFileSync(orientFile, "utf-8")).toBe("s1");
  });

  it("suppresses the headline on a repeat run with the same session id", () => {
    const repo = makeRepo(true);
    runHook(repo, { session_id: "s1", source: "startup", cwd: repo });

    const out = runHook(repo, { session_id: "s1", source: "resume", cwd: repo });

    expect(out).not.toContain("HEADLINE_MARKER");
  });

  it("re-emits the headline on a new session id", () => {
    const repo = makeRepo(true);
    runHook(repo, { session_id: "s1", source: "startup", cwd: repo });

    const out = runHook(repo, { session_id: "s2", source: "startup", cwd: repo });

    expect(out).toContain("HEADLINE_MARKER");
    const orientFile = join(repo, ".cortex", ".oriented");
    expect(readFileSync(orientFile, "utf-8")).toBe("s2");
  });

  it("does not emit the headline when CORTEX_ONBOARD=0", () => {
    const repo = makeRepo(true);
    const out = runHook(repo, { session_id: "s3", source: "startup", cwd: repo }, { CORTEX_ONBOARD: "0" });

    expect(out).not.toContain("HEADLINE_MARKER");
  });

  it("is degrade-safe on a non-indexed repo (no db, no cortex bin)", () => {
    const repo = makeRepo(false);
    const out = runHook(repo, { session_id: "s4", source: "startup", cwd: repo });

    expect(out).toContain("Cortex routing for this session");
    expect(out).not.toContain("HEADLINE_MARKER");
  });
});

// --- Real git repos, for the unindexed-checkout auto-index branch -----------
// The `.cortex/db`-only helpers above suffice for the sentinel/briefing tests,
// but the new branch guards on `git -C "$REPO" rev-parse --show-toplevel`
// succeeding, which requires an actual git repository (a bare `mkdir .git`
// is not recognized by real git).
function gitInit(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "init");
}

function gitRepoWithoutIndex(): string {
  const repo = mkdtempSync(join(tmpdir(), "cortex-hook-noidx-"));
  tempRepos.push(repo);
  gitInit(repo);
  return repo;
}

/** Install a `bin/cortex` stub inside the repo (no CLAUDE_PLUGIN_ROOT needed —
 *  check-index.sh falls back to `$REPO/bin/cortex`). Records the `index …`
 *  invocation to `${markerPath}.args` and touches `markerPath`. */
function installIndexStub(repo: string, markerPath: string): void {
  mkdirSync(join(repo, "bin"), { recursive: true });
  const bin = join(repo, "bin", "cortex");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
if [ "$1" = "index" ]; then
  printf '%s\\n' "$@" > "${markerPath}.args"
  touch "${markerPath}"
  exit 0
fi
case "$1 $2 $3" in
  "code arch --headline") echo "HEADLINE_MARKER" ;;
  "freshness "*|"freshness") echo "fresh" ;;
  "decision count"*) echo "5" ;;
  *) : ;;
esac
`,
  );
  chmodSync(bin, 0o755);
}

/** Run the hook via spawnSync so stderr is inspectable (execFileSync discards
 *  it on success). */
function runCheckIndexHook(repo: string, envOverrides: Record<string, string> = {}) {
  const res = spawnSync("bash", [HOOK], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, CORTEX_AUTO_REFRESH: "0", CORTEX_BRIEF: "1", CORTEX_ONBOARD: "1", ...envOverrides },
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("check-index.sh — auto-index an unindexed checkout", () => {
  it("kicks a detached index for an unindexed git root", () => {
    const repo = gitRepoWithoutIndex();
    const marker = join(repo, ".index-fired");
    installIndexStub(repo, marker);

    const out = runCheckIndexHook(repo);

    expect(out.stderr).toMatch(/indexing/i);
    expect(existsSync(join(repo, ".cortex", ".auto-index-attempted"))).toBe(true);
  });

  it("does nothing when CORTEX_AUTO_INDEX=0", () => {
    const repo = gitRepoWithoutIndex();
    const marker = join(repo, ".index-fired");
    installIndexStub(repo, marker);

    const out = runCheckIndexHook(repo, { CORTEX_AUTO_INDEX: "0" });

    expect(out.stderr).not.toMatch(/indexing/i);
    expect(existsSync(join(repo, ".cortex", ".auto-index-attempted"))).toBe(false);
  });
});
