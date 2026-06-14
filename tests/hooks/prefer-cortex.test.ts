import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks/prefer-cortex.sh");

// An indexed repo: non-empty .cortex/db (the hook uses `-s`, so a 0-byte file
// reads as not-indexed). Mirrors tests/hooks/check-index.test.ts.
function indexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-prefer-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".cortex"), { recursive: true });
  writeFileSync(join(root, ".cortex", "db"), "SQLite format 3\0");
  return root;
}

function unindexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-noidx-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

type Decision = "deny" | "allow";

/** Run the hook with a PreToolUse payload; return whether it denied. */
function run(payload: object): Decision {
  const out = execFileSync("bash", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
  }).trim();
  if (out === "") return "allow";
  const parsed = JSON.parse(out);
  return parsed.hookSpecificOutput?.permissionDecision === "deny" ? "deny" : "allow";
}

describe("prefer-cortex.sh — block code, allow non-code", () => {
  const repo = indexedRepo();
  const grep = (tool_input: object) => run({ tool_name: "Grep", cwd: repo, tool_input });
  const bash = (command: string) => run({ tool_name: "Bash", cwd: repo, tool_input: { command } });
  const glob = (pattern: string) => run({ tool_name: "Glob", cwd: repo, tool_input: { pattern } });

  it("denies a bare (unscoped) Grep on an indexed repo", () => {
    expect(grep({ pattern: "registerCodeTools" })).toBe("deny");
  });

  it("denies a Grep scoped to a code type", () => {
    expect(grep({ pattern: "foo", type: "ts" })).toBe("deny");
  });

  it("denies a Grep scoped to a code glob", () => {
    expect(grep({ pattern: "foo", glob: "*.ts" })).toBe("deny");
  });

  it("allows a Grep scoped to a non-code glob", () => {
    expect(grep({ pattern: "frames", glob: "*.md" })).toBe("allow");
  });

  it("allows a Grep scoped to a non-code type", () => {
    expect(grep({ pattern: "foo", type: "json" })).toBe("allow");
  });

  it("denies a primary Bash rg/grep over code", () => {
    expect(bash("rg searchGraph src/")).toBe("deny");
    expect(bash("grep -rn TODO src/index.ts")).toBe("deny");
  });

  it("allows a Bash grep that only filters a pipe (not a file search)", () => {
    expect(bash("ps aux | grep node")).toBe("allow");
    expect(bash("git log --oneline | grep fix")).toBe("allow");
    expect(bash("ls | grep .ts")).toBe("allow");
    expect(bash("cat src/index.ts | grep foo")).toBe("allow");
  });

  it("catches common code-search idioms that aren't a bare `grep` first word", () => {
    expect(bash("git grep searchGraph -- src/index.ts")).toBe("deny");
    expect(bash("command grep -rn foo src/a.ts")).toBe("deny");
    expect(bash("/usr/bin/grep -rn foo src/a.ts")).toBe("deny");
    expect(bash("find src | xargs grep foo")).toBe("deny");
  });

  it("allows a Bash grep scoped to non-code files", () => {
    expect(bash("grep -rn version package.json")).toBe("allow");
    expect(bash("rg foo --glob '*.md'")).toBe("allow");
  });

  it("honors the cortex:grep-ok escape token", () => {
    expect(bash("rg 'lookahead(?=x)' src/ # cortex:grep-ok")).toBe("allow");
  });

  it("ignores non-search Bash commands", () => {
    expect(bash("npm test")).toBe("allow");
    expect(bash("git status")).toBe("allow");
  });

  it("denies a Glob over code files, allows non-code / arbitrary file discovery", () => {
    expect(glob("**/*.ts")).toBe("deny");
    expect(glob("**/*.md")).toBe("allow");
    expect(glob("**/*.json")).toBe("allow");
  });

  it("does not touch MCP / Read / Edit tools", () => {
    expect(run({ tool_name: "mcp__cortex__search_graph", cwd: repo, tool_input: {} })).toBe("allow");
    expect(run({ tool_name: "Read", cwd: repo, tool_input: { file_path: "x.ts" } })).toBe("allow");
  });
});

describe("prefer-cortex.sh — quoted search words are not invocations", () => {
  const repo = indexedRepo();
  const bash = (command: string) => run({ tool_name: "Bash", cwd: repo, tool_input: { command } });

  it("allows a git commit whose message mentions grep/rg", () => {
    expect(bash('git commit -m "fix: grep over-match in search"')).toBe("allow");
    expect(bash("git commit -m 'refactor: move rg helpers to graph'")).toBe("allow");
  });

  it("allows echo/printf of a search word", () => {
    expect(bash('echo "use rg or grep here"')).toBe("allow");
  });

  it("still denies a real code grep that has a quoted pattern", () => {
    expect(bash('grep -rn "TODO" src/index.ts')).toBe("deny");
    expect(bash('rg "searchGraph" src/')).toBe("deny");
  });

  it("still honors a quoted non-code scope and the escape token", () => {
    expect(bash("rg foo --glob '*.md'")).toBe("allow");
    expect(bash("rg 'lookahead(?=x)' src/ # cortex:grep-ok")).toBe("allow");
  });
});

describe("prefer-cortex.sh — index gate", () => {
  it("allows everything on an unindexed repo (Cortex can't answer)", () => {
    const repo = unindexedRepo();
    expect(run({ tool_name: "Grep", cwd: repo, tool_input: { pattern: "foo" } })).toBe("allow");
    expect(run({ tool_name: "Bash", cwd: repo, tool_input: { command: "rg foo src/" } })).toBe(
      "allow",
    );
  });

  it("does NOT treat an unindexed cwd as indexed just because $CORTEX_DB is set", () => {
    const indexed = indexedRepo();
    const unindexed = unindexedRepo();
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", cwd: unindexed, tool_input: { command: "rg foo src/a.ts" } }),
      encoding: "utf-8",
      // Point CORTEX_DB at a *different* repo's real DB — the gate must still
      // anchor on the searched cwd, not this env var.
      env: { ...process.env, CORTEX_DB: join(indexed, ".cortex", "db") },
    }).trim();
    expect(out).toBe("");
  });
});

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
      env: { ...process.env, CORTEX_AUTO_INDEX: "0" },
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
