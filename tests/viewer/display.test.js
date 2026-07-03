import { describe, it, expect } from "vitest";
import { projectDisplayName } from "../../src/viewer/app/display.ts";

describe("projectDisplayName", () => {
  it("uses the basename of root_path", () =>
    expect(projectDisplayName({ name: "Users-rka-Development-cortex", root_path: "/Users/rka/Development/cortex" })).toBe("cortex"));
  it("strips a trailing slash", () =>
    expect(projectDisplayName({ name: "x", root_path: "/a/b/" })).toBe("b"));
  it("falls back to the slug when root_path is missing", () =>
    expect(projectDisplayName({ name: "legacy-slug", root_path: null })).toBe("legacy-slug"));
});
