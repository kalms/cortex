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
