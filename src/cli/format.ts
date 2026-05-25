export type Row = Record<string, unknown>;
export type Format = "table" | "json" | "plain";

export function chooseFormat(flag: string | undefined, isTTY: boolean): Format {
  if (flag === "json") return "json";
  if (flag === "plain") return "plain";
  if (flag === "table") return "table";
  return isTTY ? "table" : "plain";
}

export function formatRows(rows: Row[], format: Format): string {
  if (format === "json") return JSON.stringify(rows, null, rows.length === 0 ? 0 : 2);
  if (rows.length === 0) return "";
  if (format === "plain") {
    return rows.map((r) => Object.values(r).map((v) => String(v ?? "")).join("\t")).join("\n");
  }
  // table
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const sep = "  ";
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const header = keys.map((k, i) => pad(k, widths[i])).join(sep);
  const body = rows.map((r) => keys.map((k, i) => pad(String(r[k] ?? ""), widths[i])).join(sep)).join("\n");
  return `${header}\n${body}`;
}
