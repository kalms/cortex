// tests/frame-extraction/structural-tokens.test.ts
import { describe, it, expect } from "vitest";
import {
  STRUCTURAL_LABEL_TOKENS,
  ROUTE_METHOD_TOKENS,
  isDynamicSegment,
  isStructuralLabelToken,
  routeParamTokens,
  pathSalience,
} from "../../src/frame-extraction/structural-tokens.js";

describe("isDynamicSegment", () => {
  it("matches bracketed and grouped route segments", () => {
    expect(isDynamicSegment("[id]")).toBe(true);
    expect(isDynamicSegment("[...slug]")).toBe(true);
    expect(isDynamicSegment("[orgId]")).toBe(true);
    expect(isDynamicSegment("(marketing)")).toBe(true);
  });
  it("does not match ordinary segments", () => {
    expect(isDynamicSegment("billing")).toBe(false);
    expect(isDynamicSegment("users")).toBe(false);
  });
});

describe("isStructuralLabelToken", () => {
  it("flags MVC markers and the use prefix", () => {
    expect(isStructuralLabelToken("controller")).toBe(true);
    expect(isStructuralLabelToken("Models")).toBe(true);
    expect(isStructuralLabelToken("use")).toBe(true);
  });
  it("flags bracketed segments", () => {
    expect(isStructuralLabelToken("[id]")).toBe(true);
  });
  it("does not flag domain nouns", () => {
    expect(isStructuralLabelToken("billing")).toBe(false);
    expect(isStructuralLabelToken("user")).toBe(false); // not "use"
  });
});

describe("ROUTE_METHOD_TOKENS", () => {
  it("contains the standard HTTP verbs", () => {
    for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      expect(ROUTE_METHOD_TOKENS.has(m)).toBe(true);
    }
  });
});

describe("routeParamTokens", () => {
  it("extracts lowercased param names from member paths", () => {
    const params = routeParamTokens([
      "apps/x/pages/[orgId]/design-systems/colors.vue",
      "apps/x/pages/[orgId]/fonts.vue",
      "pages/[...slug].vue",
    ]);
    expect(params.has("orgid")).toBe(true);
    expect(params.has("slug")).toBe(true);
    expect(params.has("design-systems")).toBe(false);
  });
});

describe("pathSalience", () => {
  it("is the fraction of member paths containing the token", () => {
    const paths = ["a/email.vue", "a/banners.vue", "a/slides.vue", "a/briefs.vue"];
    expect(pathSalience("email", paths)).toBeCloseTo(0.25);
    expect(pathSalience("a", paths)).toBeCloseTo(1.0);
  });
  it("returns 0 for empty member set", () => {
    expect(pathSalience("anything", [])).toBe(0);
  });
});

describe("STRUCTURAL_LABEL_TOKENS", () => {
  it("includes the use prefix and MVC singular/plural forms", () => {
    expect(STRUCTURAL_LABEL_TOKENS.has("use")).toBe(true);
    expect(STRUCTURAL_LABEL_TOKENS.has("controller")).toBe(true);
    expect(STRUCTURAL_LABEL_TOKENS.has("controllers")).toBe(true);
    expect(STRUCTURAL_LABEL_TOKENS.has("schema")).toBe(true);
  });
});
