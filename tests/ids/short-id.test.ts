import { describe, it, expect } from "vitest";
import {
  PREFIX,
  randomToken,
  formatCanonical,
  formatDisplay,
  parseRef,
} from "../../src/ids/short-id.js";

describe("short-id grammar", () => {
  it("formats canonical and display ids with the type prefix", () => {
    expect(formatCanonical("decision", "9m2x")).toBe("D-9m2x");
    expect(formatDisplay("decision", 12)).toBe("D-12");
    expect(formatDisplay("todo", 42)).toBe("T-42");
    expect(PREFIX.decision).toBe("D");
  });

  it("randomToken is 4 chars from the Crockford alphabet with >=1 letter", () => {
    const draws = ["1234", "0000", "9m2x"];
    let i = 0;
    const rng = () => draws[Math.min(i++, draws.length - 1)];
    const tok = randomToken(rng);
    expect(tok).toBe("9m2x");
    expect(tok).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(tok).toMatch(/[a-z]/);
  });

  it("randomToken() with no injection yields a valid token", () => {
    for (let i = 0; i < 50; i++) {
      const tok = randomToken();
      expect(tok).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
      expect(tok).toMatch(/[a-z]/);
    }
  });

  it("parseRef treats all-digit tokens as seq refs", () => {
    expect(parseRef("decision", "D-12")).toEqual({ kind: "seq", seq: 12 });
    expect(parseRef("decision", "12")).toEqual({ kind: "seq", seq: 12 });
  });

  it("parseRef treats tokens with a letter as canonical refs", () => {
    expect(parseRef("decision", "D-9m2x")).toEqual({ kind: "canonical", id: "D-9m2x" });
    expect(parseRef("decision", "9m2x")).toEqual({ kind: "canonical", id: "D-9m2x" });
  });

  it("parseRef rejects a prefix mismatch and garbage", () => {
    expect(parseRef("decision", "T-12")).toBeNull();
    expect(parseRef("decision", "")).toBeNull();
    expect(parseRef("decision", "D-")).toBeNull();
  });
});

describe("story ids", () => {
  it("formats canonical story ids with the S prefix", () => {
    expect(PREFIX.story).toBe("S");
    expect(formatCanonical("story", "9m2x")).toBe("S-9m2x");
  });
  it("parses seq and canonical story refs", () => {
    expect(parseRef("story", "S-12")).toEqual({ kind: "seq", seq: 12 });
    expect(parseRef("story", "S-9m2x")).toEqual({ kind: "canonical", id: "S-9m2x" });
    expect(parseRef("story", "9m2x")).toEqual({ kind: "canonical", id: "S-9m2x" });
    expect(parseRef("story", "D-9m2x")).toBeNull();
  });
});
