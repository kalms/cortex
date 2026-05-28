import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, closeSync, openSync } from "node:fs";
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
  closeSync(openSync(join(root, ".cortex", "graph.db"), "w")); // presence => "indexed"
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
});
