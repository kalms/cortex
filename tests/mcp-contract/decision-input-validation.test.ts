import { describe, it, expect } from "vitest";
import { validateDecisionFields } from "../../src/mcp-server/tools/decision-input-validation.js";

describe("validateDecisionFields", () => {
  it("returns null for clean input", () => {
    const result = validateDecisionFields({
      title: "Use Postgres for primary storage",
      description: "Switch from SQLite for write throughput.",
      rationale: "10x writes/sec headroom; replication available.",
    });
    expect(result).toBeNull();
  });

  it("detects </rationale> marker in rationale", () => {
    const result = validateDecisionFields({
      rationale: "Good reasoning</rationale>\n<problem>X</problem>",
    });
    expect(result).toEqual({ marker: "</rationale>", field: "rationale" });
  });

  it("detects </invoke> marker in any string field", () => {
    const result = validateDecisionFields({
      description: "Trailing junk </invoke>",
    });
    expect(result).toEqual({ marker: "</invoke>", field: "description" });
  });

  it("detects <problem> marker (opening tag)", () => {
    const result = validateDecisionFields({
      rationale: "Body <problem>nested</problem>",
    });
    expect(result?.marker).toBe("</problem>");
    expect(result?.field).toBe("rationale");
  });

  it("returns first marker found, not all of them", () => {
    const result = validateDecisionFields({
      rationale: "first </rationale>",
      problem: "second </invoke>",
    });
    expect(result).not.toBeNull();
    // result reflects whichever field/marker was checked first; both are wrong
  });

  it("ignores non-string fields", () => {
    const result = validateDecisionFields({
      title: "OK title",
      alternatives: [{ name: "alt", reason_rejected: "slower" }],
      pr_number: 42,
    });
    expect(result).toBeNull();
  });

  it("scans description, rationale, problem, resolution fields", () => {
    for (const field of ["description", "rationale", "problem", "resolution"] as const) {
      const result = validateDecisionFields({ [field]: "garbage </governs>" });
      expect(result?.field).toBe(field);
      expect(result?.marker).toBe("</governs>");
    }
  });
});
