import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks/brief-edit.sh");

/** Create a minimal git repo (with a .git dir and src/ subdir) in a temp dir. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-brief-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".cortex"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  // Initialize it as a real git repo so git rev-parse works.
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

/** Write a fake `cortex` binary to a temp dir and return its path.
 *  When `output` is non-empty, `cortex brief <arg>` prints it.
 *  When empty, prints nothing. */
function fakeCortex(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cortex-fake-bin-"));
  const bin = join(dir, "cortex");
  // The fake just echoes `output` when the first arg is "brief"; otherwise no-op.
  const body = output
    ? `#!/bin/sh\nif [ "$1" = "brief" ]; then printf '%s\\n' ${JSON.stringify(output)}; fi\n`
    : `#!/bin/sh\n`;
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return dir; // return the dir so it can be prepended to PATH
}

type RunResult = { stdout: string; exitCode: number };

/** Run the hook with a given payload and env overrides. Returns stdout + exit code. */
function runHook(
  payload: object,
  opts: { env?: Record<string, string>; cortexBinDir?: string } = {},
): RunResult {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(opts.env ?? {}),
  };
  if (opts.cortexBinDir) {
    env.PATH = `${opts.cortexBinDir}:${env.PATH ?? "/usr/bin:/bin"}`;
  }
  try {
    const stdout = execFileSync("bash", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: any) {
    // execFileSync throws on non-zero exit; capture stdout from the error.
    return { stdout: (err.stdout ?? "").trim(), exitCode: err.status ?? 1 };
  }
}

function isDeny(result: RunResult): boolean {
  if (!result.stdout) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed.hookSpecificOutput?.permissionDecision === "deny";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("brief-edit.sh — tool filter", () => {
  it("(a) exits 0 with no output for non-Edit tools (Read, Bash, mcp__cortex__search_graph)", () => {
    const repo = makeRepo();
    const file = join(repo, "src/index.ts");
    writeFileSync(file, "");
    for (const tool of ["Read", "Bash", "mcp__cortex__search_graph"]) {
      const result = runHook({ tool_name: tool, tool_input: { file_path: file } });
      expect(result.stdout, `tool=${tool} should produce no output`).toBe("");
      expect(result.exitCode, `tool=${tool} should exit 0`).toBe(0);
    }
  });
});

describe("brief-edit.sh — gated file (cache present, REL in it)", () => {
  it("(b) denies an ungated file the first time and writes .brief-blocked", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    // Seed the gate cache with the relative path.
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);
    // Fake cortex prints a headline.
    const headline = "GOVERNED by D-001 (active): PublishStagedDb — blast radius 14";
    const fakeBinDir = fakeCortex(headline);

    const result = runHook(
      { tool_name: "Edit", tool_input: { file_path: file } },
      { cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result), "should deny the first time").toBe(true);
    // The deny reason must contain the headline.
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(headline);
    // .brief-blocked must now contain the relative path.
    const blockedPath = join(repo, ".cortex", ".brief-blocked");
    expect(existsSync(blockedPath), ".brief-blocked should exist").toBe(true);
    const blocked = readFileSync(blockedPath, "utf-8");
    expect(blocked.split("\n")).toContain(rel);
  });

  it("(c) allows the same file on the SECOND call (already in .brief-blocked)", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);
    // Pre-seed .brief-blocked (simulating the first-block having already fired).
    writeFileSync(join(repo, ".cortex", ".brief-blocked"), `${rel}\n`);
    const headline = "GOVERNED by D-001";
    const fakeBinDir = fakeCortex(headline);

    const result = runHook(
      { tool_name: "Edit", tool_input: { file_path: file } },
      { cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result), "second call should allow (no deny)").toBe(false);
    expect(result.stdout).toBe("");
  });

  it("(d) allows a file that is already in .briefed (studied this session)", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);
    writeFileSync(join(repo, ".cortex", ".briefed"), `${rel}\n`);
    const fakeBinDir = fakeCortex("GOVERNED by D-001");

    const result = runHook(
      { tool_name: "Write", tool_input: { file_path: file } },
      { cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result)).toBe(false);
    expect(result.stdout).toBe("");
  });
});

describe("brief-edit.sh — env gate flags", () => {
  it("(e) exits 0 when CORTEX_BRIEF_BLOCK=0", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);
    const fakeBinDir = fakeCortex("GOVERNED by D-001");

    const result = runHook(
      { tool_name: "Edit", tool_input: { file_path: file } },
      { env: { CORTEX_BRIEF_BLOCK: "0" }, cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result)).toBe(false);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when CORTEX_BRIEF=0", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);
    const fakeBinDir = fakeCortex("GOVERNED by D-001");

    const result = runHook(
      { tool_name: "Edit", tool_input: { file_path: file } },
      { env: { CORTEX_BRIEF: "0" }, cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result)).toBe(false);
    expect(result.stdout).toBe("");
  });
});

describe("brief-edit.sh — pre-filter (gate-cache present, REL NOT in it)", () => {
  it("(f) exits 0 when the gate cache exists but the file is not in it", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const otherRel = "src/other.ts"; // only other.ts is gated
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${otherRel}\n`);
    const fakeBinDir = fakeCortex("GOVERNED by D-001");

    const result = runHook(
      { tool_name: "Edit", tool_input: { file_path: file } },
      { cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result)).toBe(false);
    expect(result.stdout).toBe("");
  });
});

describe("brief-edit.sh — ungated live re-check (cortex brief returns empty)", () => {
  it("(g) exits 0 when gate cache has REL but cortex brief returns empty", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);
    // Fake cortex prints nothing (empty headline).
    const fakeBinDir = fakeCortex("");

    const result = runHook(
      { tool_name: "Edit", tool_input: { file_path: file } },
      { cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result)).toBe(false);
    expect(result.stdout).toBe("");
  });
});

describe("brief-edit.sh — degrade-safe paths", () => {
  it("exits 0 when the cortex CLI is not on PATH (no CORTEX_BIN)", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);

    const result = runHook(
      { tool_name: "Edit", tool_input: { file_path: file } },
      { env: { CORTEX_BIN: "", PATH: "/usr/bin:/bin" } },
    );

    expect(isDeny(result)).toBe(false);
    expect(result.stdout).toBe("");
  });

  it("exits 0 with empty payload", () => {
    const result = runHook({});
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("works with MultiEdit tool as well", () => {
    const repo = makeRepo();
    const rel = "src/core.ts";
    const file = join(repo, rel);
    writeFileSync(file, "");
    writeFileSync(join(repo, ".cortex", ".brief-gate-cache"), `${rel}\n`);
    const headline = "GOVERNED by D-002 (active): SomeCritical function";
    const fakeBinDir = fakeCortex(headline);

    const result = runHook(
      { tool_name: "MultiEdit", tool_input: { file_path: file } },
      { cortexBinDir: fakeBinDir },
    );

    expect(isDeny(result)).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(headline);
  });
});
