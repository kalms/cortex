import { describe, it, expect } from "vitest";
import { parseArgv, findSuggestion } from "../../src/cli/router.js";

describe("router", () => {
  it("parses 'cortex code search ribbon' into namespace + command + positional", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon"]);
    expect(r.namespace).toBe("code");
    expect(r.command).toBe("search");
    expect(r.positionals).toEqual(["ribbon"]);
  });

  it("parses --flag=value", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon", "--format=json"]);
    expect(r.flags.format).toBe("json");
  });

  it("parses --flag value (separate)", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon", "--format", "json"]);
    expect(r.flags.format).toBe("json");
  });

  it("treats bare --flag as boolean true", () => {
    const r = parseArgv(["cortex", "code", "search", "ribbon", "--explain"]);
    expect(r.flags.explain).toBe(true);
  });

  it("findSuggestion returns nearest command name", () => {
    expect(findSuggestion("seerch", ["search", "find", "show"])).toBe("search");
  });

  it("findSuggestion returns null when nothing is close", () => {
    expect(findSuggestion("xyzzy", ["search", "find", "show"])).toBeNull();
  });
});
