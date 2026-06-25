import { describe, it, expect } from "vitest";
import { classifyGovernsTarget } from "../../src/shared/classify-ref.js";

describe("classifyGovernsTarget", () => {
  it("returns 'qn' for a qualified name that contains both '::' and '/'", () => {
    expect(classifyGovernsTarget("src/foo/bar.ts::doThing")).toBe("qn");
  });

  it("returns 'path' for a file path that contains '/' but no '::'", () => {
    expect(classifyGovernsTarget("src/foo/bar.ts")).toBe("path");
  });

  it("returns 'qn' for a bare symbol with neither '/' nor '::'", () => {
    expect(classifyGovernsTarget("doThing")).toBe("qn");
  });
});
