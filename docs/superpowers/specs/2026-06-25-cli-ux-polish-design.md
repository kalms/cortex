# Design: `cortex` CLI visual polish

**Date:** 2026-06-25
**Status:** Approved (brainstorm) — pending implementation plan
**Branch / worktree:** `feature/cli/ux-polish` → `../cortex-wt-cli-ux`

## Problem

The `cortex` CLI is functionally complete but visually barebones. All output is
flat, uncolored text: tables are space-padded with no header separation, errors
are a flat `ERROR:` prefix, help screens are monochrome, and long-running
operations (`cortex index`) give no progress feedback — they can look hung.

The bones are already good: stdout/stderr are cleanly separated, `--format`
(`table` / `json` / `plain`) selection is TTY-aware, and status lines already go
to stderr. What's missing is visual hierarchy. This work adds a small, focused
styling layer — **deliberately scoped to "slightly," not a TUI overhaul**.

## Constraints & principles

- **Zero new dependencies.** The dep tree is 17 packages and intentionally lean.
  The styling needs here (a handful of ANSI codes + a gate + a spinner) are
  simple enough that a library earns little. All ANSI lives in one module.
- **Color only when interactive.** ANSI is emitted *only* to a real TTY with
  color not suppressed. Piped output, `--format json`, `--format plain`, and the
  test suite (all non-TTY) must remain **byte-for-byte unchanged** — zero ANSI
  bytes. This is the hard correctness rule that keeps pipes, machine consumers,
  and existing tests green.
- **stdout stays pipe-clean.** Spinners, status lines, and styled diagnostics go
  to **stderr**. Styled *data* (tables, help) goes to stdout but only when stdout
  itself is a TTY.
- **Formatting only, no wording changes.** Help text, error messages, and column
  contents are untouched; we only add color, glyphs, and a header rule.

## Architecture — one styling module

A single new **`src/cli/style.ts`** (~60 lines) is the only place ANSI escape
codes appear. Everything else imports from it.

### (a) Color gate + helpers

```
colorEnabled(stream): boolean =
     stream.isTTY === true
  && !process.env.NO_COLOR            // honor the NO_COLOR standard (any value)
  && process.env.TERM !== "dumb"
  && process.env.CORTEX_NO_COLOR !== "1"
  && !noColorFlag                     // explicit --no-color
```

- An optional `--color=always` override (and `CORTEX_COLOR=always`) forces color
  on even when not a TTY — useful for `less -R` and CI logs that render ANSI.
  Precedence: `--no-color` > `--color=always` > auto-detect.
- **How flag state reaches the gate:** `main.ts` resolves the color preference
  once at startup from parsed argv (`--color` / `--no-color`) and installs it
  into the `style` module via a one-time `configureColor(pref)` call. Env vars
  are read directly inside the gate. After that, `colorEnabled(stream)` needs
  only the stream's `isTTY` plus the stored preference + env — no flag threading
  through every call site.
- Helpers: `bold`, `dim`, `gray`, `red`, `green`, `yellow`, `cyan`. Each takes a
  string and returns it wrapped in the SGR pair **only when color is enabled for
  the relevant stream**; otherwise it returns the input unchanged (exact
  passthrough). The enabled-state is resolved once per process per stream and the
  helpers close over it (or take an explicit `enabled` boolean) so call sites stay
  terse.

### (b) Spinner

A tiny `Spinner` class driving braille frames on **stderr**:

- Frames: `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (canonical braille), advanced via `setInterval` (~80ms).
- ASCII fallback `|/-\` when the terminal can't render UTF-8 (detect via
  `LANG`/`LC_ALL`/`LC_CTYPE` lacking `UTF`/`utf8`).
- API: `start(text)`, `succeed(text)` → `✓` (green), `fail(text)` → `✗` (red),
  `stop()`. On finish, clears the spinner line and writes the final glyph line.
- **Auto-degrade when not a TTY:** prints a single static `… <text>` line on
  start and the final line on finish — no animation, no cursor control. Keeps CI
  logs clean.
- Always writes to stderr so stdout remains pipe-clean.

## Surface changes

### 1. Tables & lists — `src/cli/format.ts`

`formatRows(rows, format)` gains a styling pass for `format === "table"` only:

- **Header row**: `bold` + `cyan`, with a thin `dim` rule (`─` × column width, or
  `-` in ASCII mode) on the line below it.
- **Secondary columns dimmed**: a per-call set of "secondary" keys
  (`file_path`, `kind`, `depth`, `line`) render in `dim`/`gray` so the primary
  column (`name` / `symbol` / `qualified_name`) stands out. Default secondary-key
  set lives in `format.ts`; callers may override.
- **Truncation (table mode only):** any cell wider than a cap (default 60,
  clamped so the row never exceeds `stdout.columns`) is cut with a trailing `…`.
- `plain` and `json` modes are **never** colored or truncated — unchanged.
- Width math uses the **visible** string length (pre-ANSI), so color codes never
  throw off column alignment. Apply color *after* padding.

### 2. Errors & hints — `src/cli/errors.ts`

`renderError` (writes to stderr):

- `✗ <message>` — glyph + message in `red bold` (ASCII `x` fallback).
- Hint / tip / fix line: `→ <hint>` in `dim` (currently a bare line). The
  `EnvironmentError` "To fix:" framing is preserved, dimmed, with the arrow.
- Unknown-error stack trace path (`--debug`) is unchanged.
- All gated on `stderr.isTTY`.

### 3. Help & top-level — `src/cli/help.ts`

Pure formatting of the existing strings:

- Section headings (`Usage:`, `Namespaces:`, `Commands:`, `Common commands:`,
  `Meta:`, `Examples:`, `See also:`) → `bold`.
- Namespace / command names in the left column → `cyan`; descriptions default.
- Example command lines → `green` (reads as "copy-paste me").
- Tagline and wording untouched.
- Gated on `stdout.isTTY`.

### 4. Progress feedback — `src/cli/commands/index.ts`

- `cortex index` wraps its long indexer invocation in the `Spinner`:
  `⠋ indexing <project>…` → `✓ indexed <project> (<n> files, <ms>)` on success,
  `✗ <error>` on failure.
- Reuses existing indexer-output unwrapping; the spinner only wraps the `await`.
- Non-TTY (CI) prints the static start + final lines, no animation.
- The final success line's stats come from whatever the indexer already reports;
  if a clean count/duration isn't readily available, fall back to a plain
  `✓ indexed <project>`.

## Testing

- **New `tests/cli/style.test.ts`:**
  - Gate logic: TTY on/off, `NO_COLOR`, `CORTEX_NO_COLOR`, `--no-color`,
    `TERM=dumb`, `--color=always` override, and precedence between them.
  - Disabled-mode helpers are exact passthroughs (input === output).
  - Truncation: over-cap cells cut with `…`; under-cap untouched; `stdout.columns`
    clamp respected.
  - Visible-length alignment: colored cells pad to the same width as plain.
- **Spinner tests:** frame sequencing, ASCII fallback, and the non-TTY
  static-line fallback (inject a fake writable stream + fake `isTTY`).
- **Existing tests stay green untouched** — they run non-TTY → plain output. Add
  one assertion to `tests/cli/format.test.ts` confirming no ANSI bytes leak when
  color is off.

## Out of scope (YAGNI)

- No layout engine, boxes, or borders.
- No theming/config beyond the standard env gates (`NO_COLOR`, `CORTEX_NO_COLOR`,
  `CORTEX_COLOR`) and `--color` / `--no-color` flags.
- No color in `json` / `plain` output, ever.
- No spinner for commands other than `index` (the only operation slow enough to
  look hung).

## Files touched

- **New:** `src/cli/style.ts`, `tests/cli/style.test.ts`.
- **Modified:** `src/cli/format.ts`, `src/cli/errors.ts`, `src/cli/help.ts`,
  `src/cli/commands/index.ts`, `src/cli/router.ts` (parse `--color`/`--no-color`),
  `tests/cli/format.test.ts` (no-leak assertion).
