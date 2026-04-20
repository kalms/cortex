import { describe, it, expect } from "vitest";
import { normalize, denormalize } from "../../src/mcp-server/qualified-name.js";

const P = "sample-project";

describe("normalize", () => {
  const cases: Array<[string, string, string]> = [
    // [description, input, expected output]
    ["colon form, simple", "src/server.ts::handleRequest", "sample-project.src.server.handleRequest"],
    ["colon form, member notation", "src/router.ts::Router.route", "sample-project.src.router.Router.route"],
    ["colon form, nested path", "src/a/b/c.ts::fn", "sample-project.src.a.b.c.fn"],
    ["colon form, dotted symbol (namespace-nested)", "src/file.ts::A.B.C", "sample-project.src.file.A.B.C"],
    ["colon form, .js extension", "src/utils.js::formatLog", "sample-project.src.utils.formatLog"],
    ["colon form, .tsx extension", "src/ui/App.tsx::App", "sample-project.src.ui.App.App"],
    ["dotted form, already normalized", "sample-project.src.server.handleRequest", "sample-project.src.server.handleRequest"],
    ["wildcard colon form", "src/server.ts::%", "sample-project.src.server.%"],
    ["wildcard dotted form", "sample-project.src.server.%", "sample-project.src.server.%"],
    ["bare wildcard", "%handleRequest%", "%handleRequest%"],
  ];

  it.each(cases)("%s: %s → %s", (_desc, input, expected) => {
    expect(normalize(input, P)).toBe(expected);
  });

  it("throws on empty input", () => {
    expect(() => normalize("", P)).toThrow(/empty/i);
  });

  it("throws on missing project for colon-form input", () => {
    expect(() => normalize("src/server.ts::fn", "")).toThrow(/project/i);
  });
});

describe("denormalize", () => {
  const cases: Array<[string, string, string, string]> = [
    ["simple function", "sample-project.src.server.handleRequest", "src/server.ts", "src/server.ts::handleRequest"],
    ["member notation", "sample-project.src.router.Router.route", "src/router.ts", "src/router.ts::Router.route"],
    ["nested path", "sample-project.src.a.b.c.fn", "src/a/b/c.ts", "src/a/b/c.ts::fn"],
    ["dotted symbol round-trip", "sample-project.src.file.A.B.C", "src/file.ts", "src/file.ts::A.B.C"],
    ["js file", "sample-project.src.utils.formatLog", "src/utils.js", "src/utils.js::formatLog"],
  ];

  it.each(cases)("%s: %s + %s → %s", (_desc, qn, fp, expected) => {
    expect(denormalize(qn, fp)).toBe(expected);
  });

  it("falls back to raw qn when file_path is empty", () => {
    expect(denormalize("sample-project.src.server.handleRequest", "")).toBe(
      "sample-project.src.server.handleRequest"
    );
  });
});
