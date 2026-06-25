# CLI Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small, zero-dependency styling layer to the `cortex` CLI — colored tables, errors, and help, plus a braille progress spinner for `cortex index` — without changing any non-interactive output.

**Architecture:** One new module `src/cli/style.ts` owns every ANSI escape code: a color gate (TTY + env + flag detection), passthrough color helpers, a glyph set, and a spinner. Each consuming surface (`format.ts`, `errors.ts`, `help.ts`, `commands/index.ts`) renders an *enhanced* form only when color is enabled for its target stream, and falls back to the **exact current output** otherwise. This is what guarantees pipes, `--format json/plain`, and the existing test suite (all non-TTY) stay byte-for-byte unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node `child_process`/`util`. No new dependencies.

## Global Constraints

- **Zero new dependencies.** All ANSI lives in `src/cli/style.ts`.
- **Color only when interactive.** ANSI is emitted only when the target stream is a TTY and color is not suppressed. Non-TTY output (pipes, `json`, `plain`, tests) must contain **zero ANSI bytes** and remain identical to today's output.
- **stdout stays pipe-clean.** Spinner + styled diagnostics go to **stderr**. Styled data (tables, help) goes to stdout, gated on `stdout.isTTY`.
- **Formatting only.** No wording, message, or column-content changes — only color, glyphs, a header rule, and truncation.
- **ESM imports** use `.js` specifiers (e.g. `import { makeStyler } from "./style.js"`).
- **Color preference precedence** (highest first): `--no-color` flag → `--color=always` flag → `NO_COLOR` env → `CORTEX_NO_COLOR=1` → `CORTEX_COLOR=always` → auto (`isTTY && TERM!=="dumb"`).

## Prerequisites (run once before Task 1)

This worktree (`../cortex-wt-cli-ux`) was created fresh, so `node_modules` is missing (gitignored). The CLI unit tests need it. Symlink it from the main checkout:

```bash
cd /Users/rka/Development/cortex-wt-cli-ux
ln -s /Users/rka/Development/cortex/node_modules node_modules
npx vitest run tests/cli/format.test.ts   # sanity: existing CLI tests pass
```
Expected: the format/errors/help tests pass green. No `bin/cortex-indexer` is needed — no task in this plan unit-tests the indexer.

---

## File Structure

- **Create** `src/cli/style.ts` — color gate, `makeStyler`, glyphs, unicode detection, spinner. The only file containing ANSI codes.
- **Create** `tests/cli/style.test.ts` — gate logic, passthrough, glyphs, unicode detection, spinner non-TTY fallback.
- **Modify** `src/cli/format.ts` — enhanced table rendering (color header + rule, dimmed secondary columns, truncation) behind the gate.
- **Modify** `tests/cli/format.test.ts` — add no-ANSI-leak + truncation + enhanced assertions.
- **Modify** `src/cli/errors.ts` — `✗` red label + `→` dim hint when enabled; current text when disabled.
- **Modify** `src/cli/help.ts` — bold headings, cyan names, green examples when enabled.
- **Modify** `src/cli/main.ts` — parse `--color`/`--no-color`, call `configureColor`, pass a styler to help renderers.
- **Modify** `src/cli/commands/index.ts` — async indexer exec wrapped in the spinner.

---

## Task 1: Color gate + helpers + glyphs (`style.ts` core)

**Files:**
- Create: `src/cli/style.ts`
- Test: `tests/cli/style.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type ColorPref = "auto" | "always" | "never"`
  - `configureColor(pref: ColorPref): void` — sets the module-level preference once at startup.
  - `colorEnabled(stream: { isTTY?: boolean }, env?: NodeJS.ProcessEnv, pref?: ColorPref): boolean`
  - `interface Styler { enabled: boolean; bold(s:string):string; dim(s:string):string; gray(s:string):string; red(s:string):string; green(s:string):string; yellow(s:string):string; cyan(s:string):string; }`
  - `makeStyler(stream: { isTTY?: boolean }, env?: NodeJS.ProcessEnv, pref?: ColorPref): Styler`
  - `NO_STYLE: Styler` — an always-disabled styler (passthrough), for default params.
  - `supportsUnicode(env?: NodeJS.ProcessEnv): boolean`
  - `interface Glyphs { ok:string; err:string; arrow:string; ellipsis:string }`
  - `glyphs(env?: NodeJS.ProcessEnv): Glyphs`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/style.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  colorEnabled, makeStyler, NO_STYLE, supportsUnicode, glyphs, configureColor,
} from "../../src/cli/style.js";

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

describe("colorEnabled", () => {
  it("auto: enabled on a TTY with a normal TERM", () => {
    expect(colorEnabled(TTY, {}, "auto")).toBe(true);
  });
  it("auto: disabled when not a TTY", () => {
    expect(colorEnabled(PIPE, {}, "auto")).toBe(false);
  });
  it("auto: disabled when TERM=dumb", () => {
    expect(colorEnabled(TTY, { TERM: "dumb" }, "auto")).toBe(false);
  });
  it("NO_COLOR env disables even on a TTY", () => {
    expect(colorEnabled(TTY, { NO_COLOR: "1" }, "auto")).toBe(false);
    expect(colorEnabled(TTY, { NO_COLOR: "" }, "auto")).toBe(false); // any value
  });
  it("CORTEX_NO_COLOR=1 disables", () => {
    expect(colorEnabled(TTY, { CORTEX_NO_COLOR: "1" }, "auto")).toBe(false);
  });
  it("CORTEX_COLOR=always enables on a pipe", () => {
    expect(colorEnabled(PIPE, { CORTEX_COLOR: "always" }, "auto")).toBe(true);
  });
  it("pref=always enables on a pipe", () => {
    expect(colorEnabled(PIPE, {}, "always")).toBe(true);
  });
  it("pref=never beats --color=always env and TTY", () => {
    expect(colorEnabled(TTY, { CORTEX_COLOR: "always" }, "never")).toBe(false);
  });
  it("pref=always beats NO_COLOR env (explicit flag wins)", () => {
    expect(colorEnabled(PIPE, { NO_COLOR: "1" }, "always")).toBe(true);
  });
});

describe("makeStyler", () => {
  it("disabled styler is an exact passthrough", () => {
    const s = makeStyler(PIPE, {}, "never");
    expect(s.enabled).toBe(false);
    expect(s.red("x")).toBe("x");
    expect(s.bold("hi")).toBe("hi");
  });
  it("enabled styler wraps in ANSI", () => {
    const s = makeStyler(TTY, {}, "always");
    expect(s.enabled).toBe(true);
    expect(s.red("x")).toContain("\x1b[");
    expect(s.red("x")).toContain("x");
  });
  it("NO_STYLE is always disabled passthrough", () => {
    expect(NO_STYLE.enabled).toBe(false);
    expect(NO_STYLE.cyan("a")).toBe("a");
  });
});

describe("supportsUnicode / glyphs", () => {
  it("UTF-8 locale → unicode glyphs", () => {
    const env = { LANG: "en_US.UTF-8" };
    expect(supportsUnicode(env)).toBe(true);
    expect(glyphs(env).ok).toBe("✓");
    expect(glyphs(env).err).toBe("✗");
    expect(glyphs(env).arrow).toBe("→");
    expect(glyphs(env).ellipsis).toBe("…");
  });
  it("non-UTF locale → ASCII glyphs", () => {
    const env = { LANG: "C" };
    expect(supportsUnicode(env)).toBe(false);
    expect(glyphs(env).ok).toBe("OK");
    expect(glyphs(env).err).toBe("X");
    expect(glyphs(env).arrow).toBe("->");
    expect(glyphs(env).ellipsis).toBe("...");
  });
  it("CORTEX_ASCII=1 forces ASCII even on UTF-8", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8", CORTEX_ASCII: "1" })).toBe(false);
  });
});

describe("configureColor", () => {
  it("default pref is honored by makeStyler when pref arg omitted", () => {
    configureColor("never");
    expect(makeStyler(TTY).enabled).toBe(false);
    configureColor("always");
    expect(makeStyler(PIPE).enabled).toBe(true);
    configureColor("auto"); // reset for other tests
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/style.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/style.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/cli/style.ts`:

```ts
export type ColorPref = "auto" | "always" | "never";

let colorPref: ColorPref = "auto";

/** Install the process-wide color preference (parsed once from argv in main.ts). */
export function configureColor(pref: ColorPref): void {
  colorPref = pref;
}

/**
 * Decide whether to emit ANSI for a given stream. Precedence (highest first):
 *   pref=never  →  NO_COLOR/CORTEX_NO_COLOR not yet checked? No — flags win:
 *   1. pref === "never"            (--no-color)        → false
 *   2. pref === "always"           (--color=always)    → true
 *   3. NO_COLOR present (any value)                    → false
 *   4. CORTEX_NO_COLOR === "1"                         → false
 *   5. CORTEX_COLOR === "always"                       → true
 *   6. auto: stream.isTTY && TERM !== "dumb"
 */
export function colorEnabled(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  pref: ColorPref = colorPref,
): boolean {
  if (pref === "never") return false;
  if (pref === "always") return true;
  if (env.NO_COLOR !== undefined) return false;
  if (env.CORTEX_NO_COLOR === "1") return false;
  if (env.CORTEX_COLOR === "always") return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}

const SGR = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const RAW = {
  bold: SGR(1, 22),
  dim: SGR(2, 22),
  gray: SGR(90, 39),
  red: SGR(31, 39),
  green: SGR(32, 39),
  yellow: SGR(33, 39),
  cyan: SGR(36, 39),
};

export interface Styler {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  gray(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function buildStyler(enabled: boolean): Styler {
  const id = (s: string) => s;
  return {
    enabled,
    bold: enabled ? RAW.bold : id,
    dim: enabled ? RAW.dim : id,
    gray: enabled ? RAW.gray : id,
    red: enabled ? RAW.red : id,
    green: enabled ? RAW.green : id,
    yellow: enabled ? RAW.yellow : id,
    cyan: enabled ? RAW.cyan : id,
  };
}

/** An always-disabled styler — pure passthrough. Use as a default param. */
export const NO_STYLE: Styler = buildStyler(false);

export function makeStyler(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  pref: ColorPref = colorPref,
): Styler {
  return buildStyler(colorEnabled(stream, env, pref));
}

/** True when the terminal can render the unicode glyph/braille set. */
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CORTEX_ASCII === "1") return false;
  const ctype = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /UTF-?8/i.test(ctype);
}

export interface Glyphs {
  ok: string;
  err: string;
  arrow: string;
  ellipsis: string;
}

export function glyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
  return supportsUnicode(env)
    ? { ok: "✓", err: "✗", arrow: "→", ellipsis: "…" }
    : { ok: "OK", err: "X", arrow: "->", ellipsis: "..." };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/style.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/cli/style.ts tests/cli/style.test.ts
git commit -m "feat(cli): add zero-dep style module (color gate, helpers, glyphs)"
```

---

## Task 2: Braille spinner (`style.ts`)

**Files:**
- Modify: `src/cli/style.ts`
- Test: `tests/cli/style.test.ts`

**Interfaces:**
- Consumes: `makeStyler`, `glyphs`, `supportsUnicode` from Task 1.
- Produces:
  - `spinnerFrames(env?: NodeJS.ProcessEnv): string[]`
  - `interface SpinnerHandle { succeed(text?: string): void; fail(text?: string): void; stop(): void; }`
  - `interface WriteStreamLike { write(s: string): unknown; isTTY?: boolean; }`
  - `startSpinner(text: string, opts?: { stream?: WriteStreamLike; env?: NodeJS.ProcessEnv }): SpinnerHandle`

  Behavior: on a TTY, animates braille frames (~80ms) on the stream with the cursor hidden; `succeed`/`fail` clear the line and print `✓`/`✗` + text; `stop` clears the line. When **not** a TTY, prints a single static `… <text>` start line and a `✓`/`✗ <text>` final line — no animation, no cursor codes. Always writes to `process.stderr` by default.

- [ ] **Step 1: Write the failing test (append to `tests/cli/style.test.ts`)**

```ts
import { spinnerFrames, startSpinner } from "../../src/cli/style.js";

describe("spinnerFrames", () => {
  it("braille frames on UTF-8", () => {
    const f = spinnerFrames({ LANG: "en_US.UTF-8" });
    expect(f).toContain("⠋");
    expect(f.length).toBeGreaterThanOrEqual(8);
  });
  it("ASCII frames on non-UTF", () => {
    expect(spinnerFrames({ LANG: "C" })).toEqual(["|", "/", "-", "\\"]);
  });
});

describe("startSpinner (non-TTY fallback)", () => {
  function fakeStream() {
    const writes: string[] = [];
    return { writes, write(s: string) { writes.push(s); return true; }, isTTY: false };
  }
  it("prints a static start line and a success final line", () => {
    const s = fakeStream();
    const sp = startSpinner("indexing foo", { stream: s, env: { LANG: "en_US.UTF-8" } });
    sp.succeed("indexed foo");
    expect(s.writes.join("")).toBe("… indexing foo\n✓ indexed foo\n");
  });
  it("fail final line uses the err glyph; ASCII when no UTF locale", () => {
    const s = fakeStream();
    const sp = startSpinner("indexing foo", { stream: s, env: { LANG: "C" } });
    sp.fail();
    expect(s.writes.join("")).toBe("... indexing foo\nX indexing foo\n");
  });
  it("does not emit cursor-control codes when not a TTY", () => {
    const s = fakeStream();
    startSpinner("x", { stream: s, env: {} }).stop();
    expect(s.writes.join("")).not.toContain("\x1b");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/style.test.ts -t spinner`
Expected: FAIL — `spinnerFrames` / `startSpinner` not exported.

- [ ] **Step 3: Write the implementation (append to `src/cli/style.ts`)**

```ts
export function spinnerFrames(env: NodeJS.ProcessEnv = process.env): string[] {
  return supportsUnicode(env)
    ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    : ["|", "/", "-", "\\"];
}

export interface SpinnerHandle {
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

interface WriteStreamLike {
  write(s: string): unknown;
  isTTY?: boolean;
}

export function startSpinner(
  text: string,
  opts: { stream?: WriteStreamLike; env?: NodeJS.ProcessEnv } = {},
): SpinnerHandle {
  const stream: WriteStreamLike = opts.stream ?? process.stderr;
  const env = opts.env ?? process.env;
  const g = glyphs(env);

  // Non-interactive: one static start line + one final line. No animation.
  if (!stream.isTTY) {
    stream.write(`${g.ellipsis} ${text}\n`);
    let done = false;
    const final = (glyph: string, t?: string) => {
      if (done) return;
      done = true;
      stream.write(`${glyph} ${t ?? text}\n`);
    };
    return {
      succeed: (t) => final(g.ok, t),
      fail: (t) => final(g.err, t),
      stop: () => { done = true; },
    };
  }

  // Interactive: animate braille frames with the cursor hidden.
  const styler = makeStyler(stream, env);
  const frames = spinnerFrames(env);
  let i = 0;
  let done = false;
  stream.write("\x1b[?25l"); // hide cursor
  const render = () => {
    stream.write(`\r\x1b[K${styler.cyan(frames[i % frames.length])} ${text}`);
    i++;
  };
  render();
  const timer = setInterval(render, 80);
  const finish = (glyph: string, color: (s: string) => string, t?: string) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    stream.write(`\r\x1b[K${color(glyph)} ${t ?? text}\n\x1b[?25h`); // show cursor
  };
  return {
    succeed: (t) => finish(g.ok, styler.green, t),
    fail: (t) => finish(g.err, styler.red, t),
    stop: () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      stream.write("\r\x1b[K\x1b[?25h");
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/style.test.ts`
Expected: PASS (all spinner + Task 1 cases).

- [ ] **Step 5: Commit**

```bash
git add src/cli/style.ts tests/cli/style.test.ts
git commit -m "feat(cli): add braille spinner with non-TTY + ASCII fallbacks"
```

---

## Task 3: Enhanced table rendering (`format.ts`)

**Files:**
- Modify: `src/cli/format.ts`
- Test: `tests/cli/format.test.ts`

**Interfaces:**
- Consumes: `Styler`, `makeStyler`, `supportsUnicode` from Task 1.
- Produces:
  - `interface FormatOpts { styler?: Styler; maxColWidth?: number; termWidth?: number; secondaryKeys?: readonly string[]; unicode?: boolean; }`
  - `formatRows(rows: Row[], format: Format, opts?: FormatOpts): string` — **new optional 3rd arg**; with no opts, output is identical to today.
  - `tableOptsFor(stream?: { isTTY?: boolean; columns?: number }, env?: NodeJS.ProcessEnv): FormatOpts`
  - `writeRows` signature unchanged — it derives opts from `process.stdout` internally.

Enhanced rendering (only when `opts.styler?.enabled`): header cells in bold-cyan, a dim rule line under the header, columns whose key is in `secondaryKeys` (default `["file_path","kind","depth","line"]`) rendered gray, and cells truncated to `maxColWidth` (default 60, capped to `termWidth`) with the unicode/ascii ellipsis. **When the styler is disabled or absent, output is byte-for-byte the current table** (no rule, no color, no truncation). Column widths are computed from visible (pre-color, post-truncation) lengths; color is applied **after** padding so alignment is exact.

- [ ] **Step 1: Write the failing tests (add to `tests/cli/format.test.ts`)**

```ts
import { formatRows, tableOptsFor } from "../../src/cli/format.js";
import { makeStyler } from "../../src/cli/style.js";

describe("format — enhanced table (color enabled)", () => {
  const rows = [
    { name: "foo", kind: "function", file_path: "src/foo.ts" },
    { name: "barlong", kind: "module", file_path: "apps/b.vue" },
  ];
  const styler = makeStyler({ isTTY: true }, {}, "always");

  it("disabled styler / no opts → no ANSI bytes (byte-identical to today)", () => {
    expect(formatRows(rows, "table")).not.toContain("\x1b");
    expect(formatRows(rows, "plain")).not.toContain("\x1b");
    expect(formatRows(rows, "json")).not.toContain("\x1b");
  });

  it("enabled styler colors the header and adds a rule line", () => {
    const out = formatRows(rows, "table", { styler, unicode: true });
    expect(out).toContain("\x1b["); // ANSI present
    expect(out).toContain("─");     // dim rule
    expect(out).toContain("foo");
  });

  it("truncates over-cap cells with an ellipsis (enhanced mode only)", () => {
    const long = [{ name: "x", file_path: "a/very/deeply/nested/path/that/exceeds/the/cap.ts" }];
    const out = formatRows(long, "table", { styler, maxColWidth: 12, unicode: true });
    expect(out).toContain("…");
  });

  it("does NOT truncate when styler is disabled (explicit table to a pipe)", () => {
    const long = [{ name: "x", file_path: "a/very/deeply/nested/path/that/exceeds/the/cap.ts" }];
    const out = formatRows(long, "table"); // no styler
    expect(out).toContain("a/very/deeply/nested/path/that/exceeds/the/cap.ts");
    expect(out).not.toContain("…");
  });
});

describe("tableOptsFor", () => {
  it("non-TTY stream → disabled styler", () => {
    expect(tableOptsFor({ isTTY: false }, {}).styler?.enabled).toBe(false);
  });
  it("TTY stream → enabled styler + termWidth", () => {
    const opts = tableOptsFor({ isTTY: true, columns: 100 }, {});
    expect(opts.styler?.enabled).toBe(true);
    expect(opts.termWidth).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli/format.test.ts`
Expected: FAIL — `tableOptsFor` not exported / `formatRows` ignores opts.

- [ ] **Step 3: Implement — replace the body of `src/cli/format.ts`**

Keep the existing `Row`/`Format` types and `chooseFormat` untouched. Replace `formatRows` and `writeRows`, and add `FormatOpts`/`tableOptsFor`:

```ts
import { makeStyler, supportsUnicode, type Styler } from "./style.js";

export type Row = Record<string, unknown>;
export type Format = "table" | "json" | "plain";

export function chooseFormat(flag: string | undefined, isTTY: boolean): Format {
  if (flag === "json") return "json";
  if (flag === "plain") return "plain";
  if (flag === "table") return "table";
  return isTTY ? "table" : "plain";
}

export interface FormatOpts {
  styler?: Styler;
  maxColWidth?: number;
  termWidth?: number;
  secondaryKeys?: readonly string[];
  unicode?: boolean;
}

const DEFAULT_SECONDARY = ["file_path", "kind", "depth", "line"] as const;

/** Build table render options from an output stream (used by writeRows). */
export function tableOptsFor(
  stream: { isTTY?: boolean; columns?: number } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): FormatOpts {
  return {
    styler: makeStyler(stream, env),
    termWidth: typeof stream.columns === "number" ? stream.columns : undefined,
    unicode: supportsUnicode(env),
  };
}

export function formatRows(rows: Row[], format: Format, opts: FormatOpts = {}): string {
  if (format === "json") return JSON.stringify(rows, null, rows.length === 0 ? 0 : 2);
  if (rows.length === 0) return "";
  if (format === "plain") {
    return rows.map((r) => Object.values(r).map((v) => String(v ?? "")).join("\t")).join("\n");
  }

  // table
  const styler = opts.styler;
  const enhanced = styler?.enabled === true;
  const keys = Object.keys(rows[0]);
  const sep = "  ";
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

  // Truncation only in enhanced mode; never in a plain/pipe table.
  const ellipsis = opts.unicode === false ? "..." : "…";
  const baseCap = opts.maxColWidth ?? 60;
  const cap = enhanced
    ? (opts.termWidth ? Math.min(baseCap, opts.termWidth) : baseCap)
    : Infinity;
  const cell = (v: unknown): string => {
    const s = String(v ?? "");
    return s.length > cap ? s.slice(0, Math.max(1, cap - ellipsis.length)) + ellipsis : s;
  };

  const strRows = rows.map((r) => keys.map((k) => cell(r[k])));
  const widths = keys.map((k, i) =>
    Math.max(k.length, ...strRows.map((r) => r[i].length)),
  );

  if (!enhanced) {
    const header = keys.map((k, i) => pad(k, widths[i])).join(sep);
    const body = strRows.map((r) => r.map((c, i) => pad(c, widths[i])).join(sep)).join("\n");
    return `${header}\n${body}`;
  }

  const s = styler!;
  const secondary = new Set(opts.secondaryKeys ?? DEFAULT_SECONDARY);
  const header = keys.map((k, i) => s.bold(s.cyan(pad(k, widths[i])))).join(sep);
  const ruleChar = opts.unicode === false ? "-" : "─";
  const totalWidth = widths.reduce((a, w) => a + w, 0) + sep.length * (keys.length - 1);
  const rule = s.dim(ruleChar.repeat(totalWidth));
  const body = strRows
    .map((r) =>
      r
        .map((c, i) => {
          const padded = pad(c, widths[i]);
          return secondary.has(keys[i]) ? s.gray(padded) : padded;
        })
        .join(sep),
    )
    .join("\n");
  return `${header}\n${rule}\n${body}`;
}

/**
 * Write rows to stdout, or a short "no results" message to stderr if empty.
 * Styling/truncation activate only when stdout is an interactive TTY.
 */
export function writeRows(rows: Row[], format: Format, emptyMessage: string): void {
  if (rows.length === 0) {
    if (format === "json") {
      process.stdout.write("[]\n");
    } else {
      process.stderr.write(emptyMessage + "\n");
    }
    return;
  }
  const opts = format === "table" ? tableOptsFor(process.stdout) : {};
  process.stdout.write(formatRows(rows, format, opts) + "\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/cli/format.test.ts`
Expected: PASS — including the original four tests (they call `formatRows(rows, format)` with no opts → unchanged output).

- [ ] **Step 5: Commit**

```bash
git add src/cli/format.ts tests/cli/format.test.ts
git commit -m "feat(cli): colored table header/rule, dimmed secondary cols, truncation"
```

---

## Task 4: Error glyphs + colors (`errors.ts`)

**Files:**
- Modify: `src/cli/errors.ts`
- Test: `tests/cli/errors.test.ts`

**Interfaces:**
- Consumes: `makeStyler`, `glyphs` from Task 1.
- Produces: `renderError(e: unknown, stream?: { isTTY?: boolean; write(s: string): unknown }): void` — new optional `stream` param (defaults to `process.stderr`); all other exports unchanged.

When color is enabled for the stream: `✗ <message>` (glyph + message in red, glyph also bold) and a dim `→ <hint>` line (`To fix: ` prefix preserved for `EnvironmentError`). When disabled: **exactly today's output** (`ERROR: <message>` + `\n<hint>\n`).

- [ ] **Step 1: Write the failing tests (add to `tests/cli/errors.test.ts`)**

```ts
import { makeStyler } from "../../src/cli/style.js";

describe("renderError styling", () => {
  function fakeStream(isTTY: boolean) {
    const writes: string[] = [];
    return { writes, isTTY, write(s: string) { writes.push(s); return true; } };
  }

  it("non-TTY stream → plain 'ERROR:' text, no ANSI", () => {
    const s = fakeStream(false);
    renderError(new DomainError("not found", "Try: cortex code find foo"), s);
    const out = s.writes.join("");
    expect(out).toContain("ERROR: not found");
    expect(out).toContain("Try: cortex code find foo");
    expect(out).not.toContain("\x1b");
  });

  it("TTY stream → glyph + arrow + ANSI", () => {
    const s = fakeStream(true);
    renderError(new DomainError("not found", "Try: cortex code find foo"), s);
    const out = s.writes.join("");
    expect(out).toContain("\x1b[");      // colored
    expect(out).toMatch(/[✗X] /);        // error glyph
    expect(out).toContain("not found");
    expect(out).toContain("Try: cortex code find foo");
  });

  it("EnvironmentError keeps the 'To fix:' framing", () => {
    const s = fakeStream(true);
    renderError(new EnvironmentError("indexer missing", "npm install"), s);
    expect(s.writes.join("")).toContain("To fix: npm install");
  });
});
```

(Note: the existing `renderError` tests spy on `process.stderr.write`, whose `isTTY` is falsy under Vitest, so they continue to see the plain `ERROR:` path and pass unchanged.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli/errors.test.ts`
Expected: FAIL — `renderError` doesn't accept a stream / no glyph emitted.

- [ ] **Step 3: Implement — update `renderError` in `src/cli/errors.ts`**

Add the import at the top and replace `renderError` (leave the error classes, `exitCodeFor`, and `tryCommand` as-is, but update `tryCommand`'s call to pass `process.stderr` explicitly is unnecessary — the default handles it):

```ts
import { makeStyler, glyphs } from "./style.js";

// ... error classes + exitCodeFor unchanged ...

export function renderError(
  e: unknown,
  stream: { isTTY?: boolean; write(s: string): unknown } = process.stderr,
): void {
  const s = makeStyler(stream);
  const g = glyphs();

  const writeLabel = (msg: string) => {
    stream.write(s.enabled ? `${s.red(s.bold(g.err))} ${s.red(msg)}\n` : `ERROR: ${msg}\n`);
  };
  const writeHint = (hint: string, prefix = "") => {
    stream.write(s.enabled ? `\n${s.dim(`${g.arrow} ${prefix}${hint}`)}\n` : `\n${prefix}${hint}\n`);
  };

  if (e instanceof UsageError) {
    writeLabel(e.message);
    if (e.hint) writeHint(e.hint);
    return;
  }
  if (e instanceof DomainError) {
    writeLabel(e.message);
    if (e.tip) writeHint(e.tip);
    return;
  }
  if (e instanceof EnvironmentError) {
    writeLabel(e.message);
    if (e.fix) writeHint(e.fix, "To fix: ");
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  stream.write(
    s.enabled
      ? `${s.red(s.bold(g.err))} ${s.red(msg)}\n  ${s.dim("(run with --debug to see stack)")}\n`
      : `Error: ${msg}\n  (run with --debug to see stack)\n`,
  );
  if (process.env.CORTEX_CLI_DEBUG === "1" && e instanceof Error && e.stack) {
    stream.write(`\n${e.stack}\n`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/cli/errors.test.ts`
Expected: PASS — new styling tests + the original exit-code/stderr tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/errors.ts tests/cli/errors.test.ts
git commit -m "feat(cli): colored error glyph + dim hint arrow on TTY"
```

---

## Task 5: Help styling (`help.ts`) + main wiring (`main.ts`)

**Files:**
- Modify: `src/cli/help.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/cli/help.test.ts`

**Interfaces:**
- Consumes: `Styler`, `NO_STYLE`, `makeStyler`, `configureColor` from Task 1.
- Produces (help.ts): the three renderers gain an optional trailing `styler` param:
  - `renderTopLevelHelp(styler?: Styler): string`
  - `renderNamespaceHelp(namespace: string, styler?: Styler): string`
  - `renderCommandHelp(namespace: string, command: string, styler?: Styler): string`

  Default `styler` is `NO_STYLE` (disabled) → output identical to today, so existing tests pass. When enabled: section headings bold; namespace/command names cyan; example lines green. Wording unchanged.

- [ ] **Step 1: Write the failing tests (add to `tests/cli/help.test.ts`)**

```ts
import { makeStyler } from "../../src/cli/style.js";

describe("help styling", () => {
  const styler = makeStyler({ isTTY: true }, {}, "always");

  it("no styler → no ANSI (unchanged output)", () => {
    expect(renderTopLevelHelp()).not.toContain("\x1b");
    expect(renderNamespaceHelp("code")).not.toContain("\x1b");
    expect(renderCommandHelp("code", "search")).not.toContain("\x1b");
  });

  it("enabled styler colors headings/names/examples but keeps the words", () => {
    const out = renderCommandHelp("code", "search", styler);
    expect(out).toContain("\x1b[");
    expect(out).toContain("Examples:");
    expect(out).toContain("cortex code search");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli/help.test.ts`
Expected: FAIL — renderers don't accept a styler / no ANSI emitted.

- [ ] **Step 3a: Implement help styling — update `src/cli/help.ts`**

Add `import { NO_STYLE, type Styler } from "./style.js";` at the top. Thread an optional `styler` through the three exported renderers. Apply: headings via `styler.bold(...)`, name columns via `styler.cyan(...)`, example lines via `styler.green(...)`. Concretely, change the three function signatures and color the lines:

```ts
export function renderTopLevelHelp(styler: Styler = NO_STYLE): string {
  const h = (s: string) => styler.bold(s);
  const name = (s: string) => styler.cyan(s);
  const ex = (s: string) => styler.green(s);
  const lines = [
    "cortex — knowledge graph for your codebase, on the command line",
    "",
    h("Usage:"),
    "  cortex <namespace> <command> [args] [--flags]",
    "",
    h("Namespaces:"),
    `  ${name("code".padEnd(10))}  Search, view, and trace code in indexed projects`,
    `  ${name("decision".padEnd(10))}  Architectural decisions and provenance`,
    `  ${name("graph".padEnd(10))}  Raw Cypher / SQL queries (advanced)`,
    `  ${name("index".padEnd(10))}  Manage which projects are indexed`,
    `  ${name("eval".padEnd(10))}  Run the eval harness`,
    "",
    h("Common commands:"),
    `  ${ex("cortex code find <name>")}     find a symbol by name`,
    `  ${ex("cortex code show <input>")}    show source for a symbol or file`,
    `  ${ex("cortex code where <input>")}   find what calls a symbol`,
    `  ${ex("cortex decision why <input>")} show governing decisions`,
    `  ${ex("cortex eval")}                 run the eval harness`,
    "",
    h("Meta:"),
    `  ${ex("cortex tour")}                 60-second guided walkthrough`,
    `  ${ex("cortex help <topic>")}         concept-level help (qualified-names, projects, …)`,
    `  ${ex("cortex install")}              add cortex to PATH`,
    "",
    "  --version                   print version",
    "  --help                      show help for any command",
  ];
  return lines.join("\n");
}

export function renderNamespaceHelp(namespace: string, styler: Styler = NO_STYLE): string {
  const cmds = NAMESPACES[namespace];
  if (!cmds) return `unknown namespace '${namespace}'`;
  const lines = [`cortex ${namespace} — ${describeNamespace(namespace)}`, "", styler.bold("Commands:")];
  for (const [cmdName, doc] of Object.entries(cmds)) {
    lines.push(`  ${styler.cyan(cmdName.padEnd(12))}${doc.description}`);
  }
  lines.push("", `Run \`cortex ${namespace} <command> --help\` for details on any command.`);
  return lines.join("\n");
}

export function renderCommandHelp(namespace: string, command: string, styler: Styler = NO_STYLE): string {
  const doc = NAMESPACES[namespace]?.[command];
  if (!doc) return `unknown command 'cortex ${namespace} ${command}'`;
  const lines = [
    `cortex ${namespace} ${command} — ${doc.description}`,
    "",
    styler.bold("Usage:"),
    `  ${doc.usage}`,
    "",
    styler.bold("Examples:"),
    ...doc.examples.map((e) => `  ${styler.green(e)}`),
  ];
  if (doc.seeAlso?.length) {
    lines.push("", styler.bold("See also:"));
    for (const ref of doc.seeAlso) lines.push(`  ${styler.cyan(ref)}`);
  }
  return lines.join("\n");
}
```

(Note: the top-level help's namespace column now uses `padEnd(10)` + two spaces to match the original two-space-separated alignment; verify the no-ANSI test still reads the same words — it checks `toContain`, so spacing tweaks are safe.)

- [ ] **Step 3b: Wire color into `main.ts`**

At the top of `main()`, right after `const argv = parseArgv(...)`, resolve and install the preference, and build a stdout styler to pass to help:

```ts
import { configureColor, makeStyler, type ColorPref } from "./style.js";

// inside main(), immediately after parseArgv:
const colorPref: ColorPref =
  argv.flags["no-color"] === true ? "never"
  : argv.flags.color === "always" ? "always"
  : argv.flags.color === "never" ? "never"
  : "auto";
configureColor(colorPref);
const out = makeStyler(process.stdout);
```

Then update the three help render call sites in `main.ts` to pass `out`:
- `renderTopLevelHelp()` → `renderTopLevelHelp(out)` (all three occurrences)
- `renderNamespaceHelp(argv.namespace)` → `renderNamespaceHelp(argv.namespace, out)`
- `renderCommandHelp(argv.namespace, argv.command)` → `renderCommandHelp(argv.namespace, argv.command, out)`

(Leave `renderTopic`, `renderTour`, install, and setup untouched — out of scope.)

- [ ] **Step 4: Run to verify it passes + full CLI suite**

Run: `npx vitest run tests/cli/help.test.ts tests/cli/router.test.ts`
Expected: PASS. Then `npx tsc --noEmit` to confirm `main.ts` types are sound.
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/help.ts src/cli/main.ts tests/cli/help.test.ts
git commit -m "feat(cli): colored help output + --color/--no-color wiring"
```

---

## Task 6: Spinner for `cortex index`

**Files:**
- Modify: `src/cli/commands/index.ts`

**Interfaces:**
- Consumes: `startSpinner` from Task 2.
- Produces: no new exports. Converts the indexer invocation from `execFileSync` to async `execFile` (via `promisify`) so the spinner animates while the (otherwise blocking) indexer runs, and wraps it in a `startSpinner` call.

Rationale: a `setInterval` spinner cannot animate during a synchronous `execFileSync` — the event loop is blocked. Switching that one call to async frees the loop. Frames/contracts are already `await`ed and unchanged; only the indexer phase gets the spinner.

- [ ] **Step 1: Add imports + async exec helper**

At the top of `src/cli/commands/index.ts`, change the `child_process` import and add the spinner import + a promisified `execFile`:

```ts
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { startSpinner } from "../style.js";
// ... existing imports ...

const execFileAsync = promisify(execFile);
```

(`execFileSync` is still used by the `shell()` helper for status/changes/list/delete — keep it imported.)

- [ ] **Step 2: Replace the indexer-exec block**

Inside `runIndexCommand`, in the `if (cmd.command === null || ... === ".")` branch, replace the synchronous `execFileSync(...)` + immediate `unwrapIndexerResult`/`renderIndexerResult` writes with the spinner-wrapped async version. The surrounding `withIndexLock` / `stagingDbPath` / `cleanupStagingDb` / publish / register logic stays exactly as-is. Within the `try` block, replace lines that currently read:

```ts
        const indexerArgs = mode ? { repo_path: repoPath, mode } : { repo_path: repoPath };
        const raw = execFileSync(
          INDEXER_BIN,
          ["cli", "index_repository", JSON.stringify(indexerArgs)],
          {
            encoding: "utf-8",
            stdio: ["inherit", "pipe", "inherit"],
            env: { ...process.env, CORTEX_DB: stagePath },
          },
        );
        const result = unwrapIndexerResult(raw);
        process.stdout.write(renderIndexerResult(result) + "\n");
        if (result.isError) return;

        // Frames + contracts build INTO staging, so the published graph is complete.
        const project = deriveProjectName(repoPath);
```

with:

```ts
        const indexerArgs = mode ? { repo_path: repoPath, mode } : { repo_path: repoPath };
        const project = deriveProjectName(repoPath);

        const spinner = startSpinner(`indexing ${project}…`);
        let result;
        try {
          const { stdout: raw, stderr } = await execFileAsync(
            INDEXER_BIN,
            ["cli", "index_repository", JSON.stringify(indexerArgs)],
            {
              encoding: "utf-8",
              maxBuffer: 64 * 1024 * 1024, // indexer can emit a large MCP envelope
              env: { ...process.env, CORTEX_DB: stagePath },
            },
          );
          result = unwrapIndexerResult(raw);
          if (process.env.CORTEX_CLI_DEBUG === "1" && stderr) process.stderr.write(stderr);
        } catch (e) {
          spinner.fail("indexing failed");
          throw e;
        }

        if (result.isError) {
          spinner.fail("indexing failed");
          process.stdout.write(renderIndexerResult(result) + "\n"); // throws DomainError → exit 3
          return;
        }
        spinner.succeed(`indexed ${project}`);
        process.stdout.write(renderIndexerResult(result) + "\n");
```

Then delete the now-duplicate `const project = deriveProjectName(repoPath);` line that previously appeared just before `runFrameExtraction` (it's been hoisted above the spinner). The `runFrameExtraction` / `runContractExtraction` / checkpoint / `publishStagedDb` / `captureIndexMeta` / `Registry` lines remain unchanged.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: no errors. (`result` is inferred from `unwrapIndexerResult`'s return type; the `let result;` + assignment in both branches is sound because the `catch` re-throws.)

- [ ] **Step 4: Manual verification (no unit test — this spawns the indexer binary)**

This step needs the indexer binary. Symlink it from the main checkout, build, and run against this repo:

```bash
ln -sf /Users/rka/Development/cortex/bin/cortex-indexer bin/cortex-indexer
npm run build
# Interactive (TTY) — watch the braille spinner animate, then a ✓ line on stderr:
node dist/cli/main.js index .
# Piped (non-TTY) — spinner degrades to a static '… indexing' + '✓ indexed' line, stdout clean:
node dist/cli/main.js index . | cat
# Color off:
NO_COLOR=1 node dist/cli/main.js index .
```
Expected: TTY run shows an animated braille spinner on stderr that resolves to `✓ indexed <project>`; the indexer summary still prints on stdout; piped run shows no animation and no ANSI; `NO_COLOR=1` shows glyphs-but-no-color (or ASCII glyphs depending on locale). Confirm no stray spinner artifacts remain on the line after completion.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/index.ts
git commit -m "feat(cli): braille spinner for 'cortex index' (async indexer exec)"
```

---

## Final verification (after all tasks)

- [ ] **Run the full suite:** `npx vitest run` → all green (the new tests + every pre-existing test unchanged).
- [ ] **Typecheck:** `npx tsc --noEmit` → no errors.
- [ ] **No-leak spot check:** `node dist/cli/main.js code find run | cat` and `node dist/cli/main.js --help | cat` → grep for `$'\x1b'`; expect zero matches in piped output.
- [ ] **Gate 1 (code review):** `git diff main --name-only`, then `/review` on the changed files; fix Critical findings before declaring done.

---

## Self-Review

**Spec coverage:**
- Color gate + helpers + spinner module → Tasks 1, 2. ✓
- Tables (header color, dim secondary, truncation, visible-length alignment) → Task 3. ✓
- Errors (`✗` red, `→` dim hint) → Task 4. ✓
- Help (bold headings, cyan names, green examples) → Task 5. ✓
- Progress spinner for `index` (non-TTY degrade) → Task 6. ✓
- `--color=always`/`--no-color` flags + env gates + precedence → Task 1 (gate) + Task 5 (main wiring). ✓
- "Zero ANSI in json/plain/piped/non-TTY; existing tests untouched" → enforced by the disabled-styler-passthrough design + no-leak assertions in Tasks 1 & 3. ✓
- New `tests/cli/style.test.ts` + `format.test.ts` no-leak assertion → Tasks 1, 2, 3. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows full code. ✓

**Type consistency:** `Styler`, `makeStyler`, `glyphs`, `supportsUnicode`, `configureColor`, `ColorPref`, `NO_STYLE`, `spinnerFrames`, `startSpinner`, `SpinnerHandle`, `FormatOpts`, `tableOptsFor` are defined in Tasks 1–3 and consumed with matching signatures in Tasks 3–6. `renderError`'s new `stream` param and the help renderers' `styler` param are optional, preserving every existing call site. ✓
