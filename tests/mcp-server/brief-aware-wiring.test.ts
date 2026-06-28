import { describe, it, expect } from "vitest";
import { briefTargetFromArgs } from "../../src/mcp-server/repo-context.js";

describe("briefTargetFromArgs", () => {
  it("prefers qualified_name, falls back to function_name", () => {
    expect(briefTargetFromArgs({ qualified_name: "src/a.ts::b" })).toBe("src/a.ts::b");
    expect(briefTargetFromArgs({ function_name: "doThing" })).toBe("doThing");
    expect(briefTargetFromArgs({})).toBeUndefined();
  });

  it("ignores empty strings", () => {
    expect(briefTargetFromArgs({ qualified_name: "" })).toBeUndefined();
    expect(briefTargetFromArgs({ qualified_name: "", function_name: "foo" })).toBe("foo");
    expect(briefTargetFromArgs({ qualified_name: "", function_name: "" })).toBeUndefined();
  });

  it("returns qualified_name even when function_name is also present", () => {
    expect(briefTargetFromArgs({ qualified_name: "src/x.ts::fn", function_name: "fn" })).toBe("src/x.ts::fn");
  });
});
