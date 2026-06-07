import { describe, it, expect } from "vitest";
import { resolveIndexMode } from "../../src/cli/commands/index.js";
import { UsageError } from "../../src/cli/errors.js";

describe("resolveIndexMode (cortex index --mode)", () => {
  it("returns undefined when no --mode flag is given (defaults to full)", () => {
    expect(resolveIndexMode({})).toBeUndefined();
  });

  it("accepts each valid index depth", () => {
    expect(resolveIndexMode({ mode: "fast" })).toBe("fast");
    expect(resolveIndexMode({ mode: "moderate" })).toBe("moderate");
    expect(resolveIndexMode({ mode: "full" })).toBe("full");
  });

  it("rejects an unknown mode with a UsageError", () => {
    expect(() => resolveIndexMode({ mode: "turbo" })).toThrow(UsageError);
  });

  it("rejects a bare --mode (boolean) flag", () => {
    expect(() => resolveIndexMode({ mode: true })).toThrow(UsageError);
  });
});
