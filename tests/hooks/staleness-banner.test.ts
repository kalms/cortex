import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks/check-index.sh");

/** An indexed-looking repo: a non-empty .cortex/db is what the hook checks. */
function indexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-banner-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  mkdirSync(join(root, ".cortex"), { recursive: true });
  writeFileSync(join(root, ".cortex", "db"), "not-really-a-db-but-non-empty");
  mkdirSync(join(root, "bin"), { recursive: true });
  return root;
}

/** A fake `bin/cortex`. `staleness` prints `out`; `reconcile status` always
 *  prints a non-zero count, so a hook that still called it would be caught. */
function fakeCortex(root: string, out: string): void {
  const bin = join(root, "bin", "cortex");
  writeFileSync(bin,
    `#!/bin/sh\n` +
    `case "$1" in\n` +
    `  staleness) printf '%s\\n' ${JSON.stringify(out)} ;;\n` +
    `  reconcile) printf '56\\n' ;;\n` +
    `  freshness) printf 'fresh\\n' ;;\n` +
    `  decision) printf '1\\n' ;;\n` +
    `  *) : ;;\n` +
    `esac\n`);
  chmodSync(bin, 0o755);
}

function runHook(root: string): string {
  const env = { ...(process.env as Record<string, string>) };
  for (const k of ["CORTEX_BIN", "CLAUDE_PLUGIN_ROOT", "CORTEX_STALENESS"]) delete env[k];
  env.CORTEX_AUTO_INDEX = "0";
  env.CORTEX_AUTO_REFRESH = "0";
  env.CORTEX_BRIEF = "0";
  env.CORTEX_GC = "0";
  return execFileSync("bash", [HOOK], {
    cwd: root, env, encoding: "utf8",
    input: JSON.stringify({ session_id: "s1", source: "startup", cwd: root }),
  });
}

describe("check-index.sh staleness banner", () => {
  it("prints the staleness headline when the sweep flagged something", () => {
    const root = indexedRepo();
    fakeCortex(root, "↻ cortex staleness: 2 authored row(s) whose basis moved in the last index.");
    expect(runHook(root)).toContain("2 authored row(s) whose basis moved");
  });

  it("prints nothing about staleness when the sweep is silent", () => {
    const root = indexedRepo();
    fakeCortex(root, "");
    expect(runHook(root)).not.toContain("cortex staleness");
  });

  it("no longer prints the raw drifted-decision count", () => {
    const root = indexedRepo();
    fakeCortex(root, "");
    const out = runHook(root);
    expect(out).not.toContain("drifted since last reconciliation");
    expect(out).not.toContain("56");
  });
});
