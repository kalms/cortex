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
