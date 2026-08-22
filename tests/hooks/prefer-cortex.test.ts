import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
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

type Decision = "deny" | "allow" | "ask";

/** Run the hook with a PreToolUse payload; return whether it denied. */
function run(payload: object): Decision {
  const out = execFileSync("bash", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
  }).trim();
  if (out === "") return "allow";
  const parsed = JSON.parse(out);
  const d = parsed.hookSpecificOutput?.permissionDecision;
  return d === "deny" ? "deny" : d === "ask" ? "ask" : "allow";
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

  it("routes the cortex:grep-ok escape to the USER, never self-authorizing", () => {
    // The model writes this token itself, so auto-allowing it made the gate
    // advisory. It must ask, not allow.
    expect(bash("rg 'lookahead(?=x)' src/ # cortex:grep-ok")).toBe("ask");
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

  it("still honors a quoted non-code scope; the escape token asks", () => {
    expect(bash("rg foo --glob '*.md'")).toBe("allow");
    expect(bash("rg 'lookahead(?=x)' src/ # cortex:grep-ok")).toBe("ask");
  });
});

describe("prefer-cortex.sh — index gate", () => {
  it("allows everything on an unindexed repo (Cortex can't answer)", () => {
    const repo = unindexedRepo();
    const grepOut = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Grep", cwd: repo, tool_input: { pattern: "foo" } }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_AUTO_INDEX: "0" },
    }).trim();
    expect(grepOut).toBe("");
    const bashOut = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", cwd: repo, tool_input: { command: "rg foo src/" } }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_AUTO_INDEX: "0" },
    }).trim();
    expect(bashOut).toBe("");
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

/** A fake `cortex` CLI that records its argv (one per line, to
 *  `${markerPath}.args`), touches the marker, and exits 0 — so tests can assert
 *  both that it spawned AND that the invocation form is one the real CLI
 *  accepts. */
function stubCortex(markerPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cortex-stub-"));
  const bin = join(dir, "cortex");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${markerPath}.args"\ntouch "${markerPath}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** Poll for a file up to timeoutMs (detached spawn is async). */
function waitForFile(p: string, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return true;
    execFileSync("sleep", ["0.05"]);
  }
  return existsSync(p);
}

describe("prefer-cortex.sh — sibling auto-index", () => {
  it("background-indexes an unindexed high-certainty git sibling, then allows", () => {
    const cwd = indexedRepo();
    const sibling = unindexedRepo();
    const marker = join(sibling, ".index-fired");
    const bin = stubCortex(marker);
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Grep", cwd, tool_input: { pattern: "foo", type: "ts", path: sibling } }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_BIN: bin, CORTEX_AUTO_INDEX: "1" },
    }).trim();
    expect(out).toBe("");
    expect(waitForFile(marker)).toBe(true);
    expect(existsSync(join(sibling, ".cortex", ".auto-index-attempted"))).toBe(true);
    // The invocation MUST be a form the real `cortex` CLI supports: `index . <path>`
    // (the `.` makes "index" the command and <path> the positional target).
    // Guards against re-introducing the non-existent `index repository --path=` form.
    const recordedArgs = readFileSync(`${marker}.args`, "utf-8").trim().split("\n");
    expect(recordedArgs).toEqual(["index", ".", sibling]);
  });

  // Regression: a sibling under the SYSTEM temp dir (`/tmp` on Linux, where
  // `os.tmpdir()` lives) must still auto-index. Bare `tmp` was once in the
  // denylist, which silently blocked every Linux temp-dir repo (CI-only failure;
  // macOS temp is /var/folders so it slipped through). Build the repo under an
  // explicit `/tmp` path so the `tmp` path-segment is present on both platforms.
  it("background-indexes a sibling under system /tmp (bare tmp not denylisted)", () => {
    const cwd = indexedRepo();
    const sibling = mkdtempSync("/tmp/cortex-noidx-systmp-");
    mkdirSync(join(sibling, ".git"), { recursive: true });
    const marker = join(sibling, ".index-fired");
    const bin = stubCortex(marker);
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Grep", cwd, tool_input: { pattern: "foo", type: "ts", path: sibling } }),
      encoding: "utf-8",
      env: { ...process.env, CORTEX_BIN: bin, CORTEX_AUTO_INDEX: "1" },
    }).trim();
    expect(out).toBe("");
    expect(waitForFile(marker)).toBe(true);
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
    expect(out).toBe("");
    expect(waitForFile(marker, 600)).toBe(false);
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
    writeFileSync(join(sibling, ".cortex", ".auto-index-attempted"), "");
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
      env: { ...process.env, CORTEX_BIN: "", CORTEX_AUTO_INDEX: "1", PATH: "/usr/bin:/bin" },
    }).trim();
    expect(out).toBe("");
  });
});

// --- Real git repos, for worktree canonicalization ---------------------------
// The fake-`.git`-dir helpers above are enough for the path/index gates, but a
// worktree test needs git to actually answer `--git-common-dir`.
function gitInit(root: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "init");
}

/** An indexed MAIN checkout plus a linked worktree that has no .cortex/ of its own. */
function indexedRepoWithWorktree(): { main: string; worktree: string } {
  const main = mkdtempSync(join(tmpdir(), "cortex-wt-main-"));
  gitInit(main);
  mkdirSync(join(main, ".cortex"), { recursive: true });
  writeFileSync(join(main, ".cortex", "db"), "SQLite format 3\0");
  const worktree = join(mkdtempSync(join(tmpdir(), "cortex-wt-link-")), "wt");
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "wt", worktree], {
    stdio: "pipe",
  });
  return { main, worktree };
}

describe("prefer-cortex.sh — worktrees canonicalize to the main checkout (D-b248)", () => {
  const { main, worktree } = indexedRepoWithWorktree();

  it("sanity: the linked worktree has no .cortex/db of its own", () => {
    expect(existsSync(join(worktree, ".cortex", "db"))).toBe(false);
    expect(existsSync(join(main, ".cortex", "db"))).toBe(true);
  });

  it("DENIES a Bash code grep run from inside a linked worktree", () => {
    expect(run({ tool_name: "Bash", cwd: worktree, tool_input: { command: "rg foo src/" } })).toBe(
      "deny",
    );
  });

  it("DENIES a Grep from inside a linked worktree", () => {
    expect(run({ tool_name: "Grep", cwd: worktree, tool_input: { pattern: "foo", type: "ts" } })).toBe(
      "deny",
    );
  });

  it("DENIES a code grep whose PATH ARG points into a linked worktree", () => {
    expect(
      run({ tool_name: "Bash", cwd: main, tool_input: { command: `rg foo ${worktree}/src/` } }),
    ).toBe("deny");
  });

  it("still allows non-code searches inside a worktree", () => {
    expect(run({ tool_name: "Bash", cwd: worktree, tool_input: { command: "grep -n x README.md" } })).toBe(
      "allow",
    );
  });
});

describe("prefer-cortex.sh — non-grep code-discovery shapes", () => {
  const repo = indexedRepo();
  const bash = (command: string) => run({ tool_name: "Bash", cwd: repo, tool_input: { command } });

  it("denies `find -name` over code files (a Glob in disguise)", () => {
    expect(bash("find . -name '*.ts'")).toBe("deny");
    expect(bash("find src -iname '*.tsx' -print")).toBe("deny");
  });

  it("allows `find` for non-code / arbitrary file discovery", () => {
    expect(bash("find . -iname '*corpus*' -print")).toBe("allow");
    expect(bash("find . -name '*.md'")).toBe("allow");
    expect(bash("find . -type d -name node_modules -prune")).toBe("allow");
  });

  it("denies an interpreter heredoc that reads and scans a source file", () => {
    expect(bash("python3 - <<'PY'\nimport re\nsrc=open('src/assertions/types.ts').read()\nPY")).toBe(
      "deny",
    );
    expect(bash("node -e \"const s=require('fs').readFileSync('src/index.ts','utf8')\"")).toBe("deny");
  });

  it("does not flag ordinary interpreter use", () => {
    expect(bash("node scripts/build.js")).toBe("allow");
    expect(bash("python3 -c 'print(1+1)'")).toBe("allow");
    expect(bash("npm test")).toBe("allow");
  });

  it("does not flag an interpreter WRITING a source file", () => {
    expect(bash("python3 - <<'PY'\nopen('src/gen.ts','w').write(x)\nPY")).toBe("allow");
  });

  it("routes cortex:grep-ok to the user for both new shapes", () => {
    expect(bash("find . -name '*.ts' # cortex:grep-ok")).toBe("ask");
    expect(bash("python3 -c \"open('src/a.ts').read()\" # cortex:grep-ok")).toBe("ask");
  });
});

describe("prefer-cortex.sh — the denial must not teach the bypass", () => {
  const repo = indexedRepo();
  function reason(command: string): string {
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", cwd: repo, tool_input: { command } }),
      encoding: "utf-8",
    }).trim();
    return JSON.parse(out).hookSpecificOutput?.permissionDecisionReason ?? "";
  }

  it("no denial text mentions the escape token", () => {
    // Advertising the escape at the moment of denial is what taught the model
    // to re-issue a denied grep with the token instead of using Cortex.
    for (const cmd of ["rg foo src/", "find . -name '*.ts'", "python3 -c \"open('src/a.ts').read()\""]) {
      expect(reason(cmd)).not.toContain("cortex:grep-ok");
    }
  });

  it("denials name the scoping parameters that replace a raw grep", () => {
    const r = reason("rg foo src/");
    expect(r).toContain("search_code");
    expect(r).toContain("path=");
    expect(r).toContain("glob=");
  });
});

describe("prefer-cortex.sh — review regressions", () => {
  const repo = indexedRepo();
  const bash = (command: string) => run({ tool_name: "Bash", cwd: repo, tool_input: { command } });

  it("the escape token only converts a DENY into an ask, never fires on its own", () => {
    // Hoisting the check made any command containing the string ask.
    expect(bash('git commit -m "fix: document cortex:grep-ok in the hook"')).toBe("allow");
    expect(bash("grep -n TODO README.md # cortex:grep-ok")).toBe("allow");
    expect(bash("rg foo src/ # cortex:grep-ok")).toBe("ask");
  });

  it("allows `find` that DOES work rather than finds it", () => {
    expect(bash("find dist -name '*.js' -delete")).toBe("allow");
    expect(bash("find . -name '*.ts' -exec prettier --write {} +")).toBe("allow");
    expect(bash("find . -name '*.ts'")).toBe("deny"); // still a Glob in disguise
  });

  it("does not flag interpreters using async / pathlib write forms", () => {
    expect(bash("node -e \"require('fs').promises.writeFile('src/a.ts', out)\"")).toBe("allow");
    expect(bash("python3 -c \"import pathlib; pathlib.Path('src/a.ts').write_text(s)\"")).toBe("allow");
  });

  it("denial text no longer claims search_code covers ALL files", () => {
    const out = execFileSync("bash", [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", cwd: repo, tool_input: { command: "rg foo src/" } }),
      encoding: "utf-8",
    }).trim();
    const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
    expect(reason).not.toContain("ALL files");
    expect(reason).toContain("non-code"); // the fallback sentence is restored
  });
});
