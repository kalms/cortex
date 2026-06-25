import { describe, it, expect } from "vitest";
import { formatRows, tableOptsFor, type Row } from "../../src/cli/format.js";
import { makeStyler } from "../../src/cli/style.js";

describe("format", () => {
  const rows: Row[] = [
    { name: "foo", kind: "function", file_path: "src/foo.ts" },
    { name: "barlong", kind: "module", file_path: "apps/b.vue" },
  ];

  it("plain format: tab-separated rows", () => {
    const out = formatRows(rows, "plain");
    expect(out).toBe("foo\tfunction\tsrc/foo.ts\nbarlong\tmodule\tapps/b.vue");
  });

  it("json format: JSON array", () => {
    const out = formatRows(rows, "json");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("foo");
  });

  it("table format: aligned columns with header", () => {
    const out = formatRows(rows, "table");
    expect(out).toMatch(/name\s+kind\s+file_path/);
    // Alignment: barlong is 7 chars, foo is 3 — column width must be at least 7
    expect(out).toMatch(/foo\s{4,}function/);
  });

  it("empty input returns empty string", () => {
    expect(formatRows([], "plain")).toBe("");
    expect(formatRows([], "json")).toBe("[]");
    expect(formatRows([], "table")).toBe("");
  });
});

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
