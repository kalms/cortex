import { describe, it, expect } from "vitest";
import { formatRows, type Row } from "../../src/cli/format.js";

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
