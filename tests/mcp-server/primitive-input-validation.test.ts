import { describe, it, expect } from "vitest";
import { validatePrimitiveFields, validateDecisionFields } from "../../src/mcp-server/tools/decision-input-validation.js";

describe("validatePrimitiveFields", () => {
  it("flags a stray tool-call marker in a named field", () => {
    expect(validatePrimitiveFields({ summary: "ok</invoke> leak" }, ["summary"]))
      .toEqual({ marker: "</invoke>", field: "summary" });
  });
  it("ignores fields not in the scan list", () => {
    expect(validatePrimitiveFields({ note: "x</invoke>" }, ["summary"])).toBeNull();
  });
  it("validateDecisionFields still scans the decision fields", () => {
    expect(validateDecisionFields({ rationale: "x</rationale>" }))
      .toEqual({ marker: "</rationale>", field: "rationale" });
  });
});
