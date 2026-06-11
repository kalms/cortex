import { describe, it, expect } from "vitest";
import { classifySearchExec } from "../../src/mcp-server/tools/code-tools.js";

// Reproduced error shapes (see PR investigation — confirmed via Node execFile
// against the bundled @vscode/ripgrep binary on 2026-06-11):
//   - no matches:     code=1,  stdout="",            stderr=""
//   - invalid regex:  code=2,  stdout="",            stderr="rg: regex parse error: …"
//   - read error:     code=2,  stdout="",            stderr="…: No such file…"
//   - timeout:        code=null, signal="SIGTERM", killed=true, stdout=partial|""
//   - maxBuffer:      code="ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout=partial
//
// The bug this guards against: the primary rg path mapped exit-2 and
// timeout-with-no-stdout to an opaque `internal_error`, hiding the actionable
// "your pattern is invalid regex" signal and masking incomplete searches.
describe("classifySearchExec", () => {
  it("ENOENT → missing (caller falls back to the other binary)", () => {
    expect(classifySearchExec({ code: "ENOENT" })).toEqual({ kind: "missing" });
  });

  it("exit 1 with no output → empty (no matches, not an error)", () => {
    expect(classifySearchExec({ code: 1, stdout: "" })).toEqual({ kind: "empty" });
  });

  it("exit 1 with buffered output → output (use what we got)", () => {
    expect(classifySearchExec({ code: 1, stdout: "a.ts:1:hit\n" })).toEqual({
      kind: "output",
      stdout: "a.ts:1:hit\n",
    });
  });

  it("exit 2 + regex-parse stderr → invalid_pattern carrying the parse error", () => {
    const out = classifySearchExec({
      code: 2,
      stdout: "",
      stderr: "rg: regex parse error:\n    (?:()\n    ^\nerror: unclosed group",
    });
    expect(out.kind).toBe("invalid_pattern");
    if (out.kind === "invalid_pattern") {
      expect(out.detail).toContain("unclosed group");
    }
  });

  it("grep-style invalid regex stderr → invalid_pattern", () => {
    const out = classifySearchExec({
      code: 2,
      stdout: "",
      stderr: "grep: Invalid regular expression",
    });
    expect(out.kind).toBe("invalid_pattern");
  });

  // GNU grep's real unbalanced-bracket message (the docstring previously claimed
  // grep says "unmatched"/"unbalanced" — it doesn't; this is the actual wording).
  it("GNU grep 'brackets ([ ]) not balanced' → invalid_pattern", () => {
    expect(
      classifySearchExec({ code: 2, stdout: "", stderr: "grep: brackets ([ ]) not balanced" }).kind,
    ).toBe("invalid_pattern");
  });

  // BSD grep (macOS /usr/bin/grep) uses a hyphenated wording.
  it("BSD grep 'repetition-operator operand invalid' → invalid_pattern", () => {
    expect(
      classifySearchExec({ code: 2, stdout: "", stderr: "grep: repetition-operator operand invalid" })
        .kind,
    ).toBe("invalid_pattern");
  });

  it("rg 'Unmatched (' regex error → invalid_pattern", () => {
    expect(
      classifySearchExec({ code: 2, stdout: "", stderr: "grep: Unmatched ( or \\(" }).kind,
    ).toBe("invalid_pattern");
  });

  // Regression guard: a read error on a file/dir literally named "unmatched"
  // must NOT be misread as a bad pattern (bare-word false positive).
  it("read error on a path containing 'unmatched' → empty, NOT invalid_pattern", () => {
    expect(
      classifySearchExec({
        code: 2,
        stdout: "",
        stderr: "rg: ./unmatched: Permission denied (os error 13)",
      }),
    ).toEqual({ kind: "empty" });
  });

  it("read error on a path containing 'regex' → empty, NOT invalid_pattern", () => {
    expect(
      classifySearchExec({
        code: 2,
        stdout: "",
        stderr: "rg: ./src/regex_parser.ts: Permission denied (os error 13)",
      }),
    ).toEqual({ kind: "empty" });
  });

  it("exit 2 read error (non-regex) with no output → empty (incomplete, not a crash)", () => {
    expect(
      classifySearchExec({ code: 2, stdout: "", stderr: "rg: ./x: No such file or directory" }),
    ).toEqual({ kind: "empty" });
  });

  it("exit 2 with partial output → output (prefer what completed)", () => {
    expect(classifySearchExec({ code: 2, stdout: "a.ts:1:hit\n", stderr: "rg: ./x: denied" })).toEqual(
      { kind: "output", stdout: "a.ts:1:hit\n" },
    );
  });

  it("SIGTERM timeout with no output → empty (incomplete search, not internal_error)", () => {
    expect(classifySearchExec({ code: null, signal: "SIGTERM", killed: true, stdout: "" })).toEqual({
      kind: "empty",
    });
  });

  it("SIGTERM timeout with partial output → output", () => {
    expect(
      classifySearchExec({ code: null, signal: "SIGTERM", killed: true, stdout: "a.ts:1:hit\n" }),
    ).toEqual({ kind: "output", stdout: "a.ts:1:hit\n" });
  });

  it("maxBuffer overflow → output (use the truncated buffer)", () => {
    expect(
      classifySearchExec({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "a.ts:1:hit\n" }),
    ).toEqual({ kind: "output", stdout: "a.ts:1:hit\n" });
  });

  it("genuinely unexpected error with no output → error (only the true-unknown bucket)", () => {
    expect(classifySearchExec({ code: 137, stdout: "", message: "boom" })).toEqual({
      kind: "error",
      detail: "boom",
    });
  });
});
