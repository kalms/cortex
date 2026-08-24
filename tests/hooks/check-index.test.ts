import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks/check-index.sh");

/** Make a fake `cortex` launcher on a temp bin dir that echoes a fixed count. */
function fakeCortexBin(dir: string, count: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "cortex");
  writeFileSync(launcher, `#!/usr/bin/env bash\n# args: decision count\necho "${count}"\n`);
  chmodSync(launcher, 0o755);
  return dir; // CLAUDE_PLUGIN_ROOT
}

function runHook(repo: string, pluginRoot: string): string {
  return execFileSync("bash", [HOOK], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
  });
}

function indexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-hook-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".cortex"), { recursive: true });
  // Non-empty file => "indexed". A real graph DB always has content; the hook
  // now uses `-s` (exists AND non-empty) so a 0-byte file reads as not-indexed
  // (a degraded/aborted index), per the freshness work.
  writeFileSync(join(root, ".cortex", "graph.db"), "SQLite format 3\0");
  return root;
}

describe("check-index.sh cold-start prompt", () => {
  it("prompts to seed when indexed with zero decisions", () => {
    const repo = indexedRepo();
    const plugin = fakeCortexBin(mkdtempSync(join(tmpdir(), "cortex-plugin-")), "0");
    try {
      expect(runHook(repo, plugin)).toMatch(/No decisions captured yet/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("does NOT prompt when decisions already exist", () => {
    const repo = indexedRepo();
    const plugin = fakeCortexBin(mkdtempSync(join(tmpdir(), "cortex-plugin-")), "7");
    try {
      expect(runHook(repo, plugin)).not.toMatch(/No decisions captured yet/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("does NOT error or prompt when the launcher is unavailable", () => {
    const repo = indexedRepo();
    const emptyPlugin = mkdtempSync(join(tmpdir(), "cortex-plugin-")); // no bin/cortex
    try {
      const out = runHook(repo, emptyPlugin);
      expect(out).not.toMatch(/No decisions captured yet/i);
      expect(out).toMatch(/Index state: indexed/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(emptyPlugin, { recursive: true, force: true });
    }
  });

  it("does NOT error or prompt when CLAUDE_PLUGIN_ROOT is unset", () => {
    const repo = indexedRepo();
    try {
      const out = execFileSync("bash", [HOOK], {
        cwd: repo,
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" },
      });
      expect(out).not.toMatch(/No decisions captured yet/i);
      expect(out).toMatch(/Index state: indexed/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- Fix 1: auto-index denylist -------------------------------------------
// The SessionStart auto-index branch had no denylist guard (unlike
// prefer-cortex.sh's maybe_bg_index), so a session starting inside an
// eval-corpus clone / vendored checkout / node_modules package would spawn a
// full detached `cortex index` and write `.cortex/` into that tree. These
// tests exercise the real (unindexed) auto-index spawn path, which needs a
// REAL git repo — `git rev-parse --show-toplevel` on a fake `.git` dir (as
// `indexedRepo()` above uses) fails, so $GIT_ROOT stays empty and the spawn
// condition's `[ -n "$GIT_ROOT" ]` guard never passes.

function realGitRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
}

/** A `cortex` launcher that both answers `decision count` (so the rest of the
 *  hook proceeds normally) AND records an `index` invocation to `${marker}`. */
function stubCortexWithIndexMarker(pluginDir: string, marker: string): string {
  const bin = join(pluginDir, "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "cortex");
  writeFileSync(
    launcher,
    [
      "#!/usr/bin/env bash",
      // Distinguish the actual auto-index spawn (`cortex index . <path>`) from
      // the unrelated `cortex index sweep` GC call the hook also makes near
      // its end (both have $1 = "index") — only the former should touch the
      // marker.
      'if [ "$1" = "index" ] && [ "$2" = "." ]; then',
      `  touch "${marker}"`,
      "  exit 0",
      "fi",
      'if [ "$1" = "decision" ] && [ "$2" = "count" ]; then',
      '  echo "0"',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  return pluginDir; // CLAUDE_PLUGIN_ROOT
}

function waitForFile(p: string, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return true;
    execFileSync("sleep", ["0.05"]);
  }
  return existsSync(p);
}

describe("check-index.sh — auto-index denylist", () => {
  it("does NOT spawn an index for a checkout under node_modules", () => {
    const base = mkdtempSync(join(tmpdir(), "cortex-hook-deny-"));
    const nested = join(base, "host", "node_modules", "pkg");
    mkdirSync(nested, { recursive: true });
    realGitRepo(nested);
    const plugin = mkdtempSync(join(tmpdir(), "cortex-hook-deny-plugin-"));
    const marker = join(base, ".should-not-fire");
    try {
      stubCortexWithIndexMarker(plugin, marker);
      execFileSync("bash", [HOOK], {
        cwd: nested,
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, CORTEX_AUTO_INDEX: "1" },
      });
      expect(waitForFile(marker, 600)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("still spawns an index for a normal (non-denylisted) unindexed checkout", () => {
    const repo = mkdtempSync(join(tmpdir(), "cortex-hook-normal-"));
    realGitRepo(repo);
    const plugin = mkdtempSync(join(tmpdir(), "cortex-hook-normal-plugin-"));
    const marker = join(repo, ".should-fire");
    try {
      stubCortexWithIndexMarker(plugin, marker);
      execFileSync("bash", [HOOK], {
        cwd: repo,
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, CORTEX_AUTO_INDEX: "1" },
      });
      expect(waitForFile(marker)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(plugin, { recursive: true, force: true });
    }
  });
});
