import { describe, it, expect } from "vitest";
import { fuzzyScore } from "../../src/viewer/app/palette/fuzzy.ts";

describe("fuzzyScore", () => {
  it("returns 0 for a non-match", () => expect(fuzzyScore("xyz", "engine.js")).toBe(0));
  it("matches subsequences", () => expect(fuzzyScore("egn", "engine")).toBeGreaterThan(0));
  it("empty query matches everything equally", () =>
    expect(fuzzyScore("", "anything")).toBeGreaterThan(0));
  it("is case-insensitive", () =>
    expect(fuzzyScore("ENG", "engine.js")).toBeGreaterThan(0));
  it("prefers contiguous matches", () =>
    expect(fuzzyScore("eng", "engine.js")).toBeGreaterThan(fuzzyScore("egn", "engine.js")));
  it("prefers boundary starts (basename beats mid-word)", () =>
    expect(fuzzyScore("store", "app/store.ts")).toBeGreaterThan(fuzzyScore("store", "restored.ts")));
  it("prefers shorter targets on equal structure", () =>
    expect(fuzzyScore("eng", "engine")).toBeGreaterThan(fuzzyScore("eng", "engine-supervisor-long")));
});
