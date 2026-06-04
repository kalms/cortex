// tests/frame-extraction/eval-labels.test.ts
import { describe, it, expect } from "vitest";
import { checkLabelQuality, routeParamTokens } from "../../src/frame-extraction/eval-labels.js";
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

function cl(id: number, paths: string[]): ClusterAssignment {
  return { cluster_id: id, member_paths: paths };
}

describe("checkLabelQuality", () => {
  it("flags a label driven by a single member (no >=50% shared token)", () => {
    const clusters = [cl(0, [
      "apps/x/app/pages/x/banners.vue",
      "apps/x/app/pages/x/briefs.vue",
      "apps/x/app/pages/x/email.vue",
      "apps/x/app/pages/x/slides.vue",
      "apps/x/app/pages/x/index.vue",
    ])];
    const topTokens = { "0": ["email", "x", "pages"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.find((x) => x.cluster_id === 0)?.rule).toBe("non_salient_label");
  });
  it("does NOT emit a route-param token in the label (salience gate + route-param gate prevent it)", () => {
    // pickFrameLabel now rejects 'orgid' (route param) and 'design' (0% salience in these paths),
    // falling through to path-prefix 'orgs'. checkLabelQuality should report no violation.
    const clusters = [cl(1, ["a/orgs/[orgId]/x.ts", "a/orgs/[orgId]/y.ts"])];
    const topTokens = { "1": ["orgid design", "design"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.filter((x) => x.cluster_id === 1)).toHaveLength(0);
  });
  it("flags a bare MVC layer marker as the label", () => {
    const clusters = [cl(2, ["app/controllers/a.rb", "app/controllers/b.rb"])];
    const topTokens = { "2": ["controller"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.find((x) => x.cluster_id === 2)?.rule).toBe("structural_token_in_label");
  });
  it("passes a clean domain label shared across members", () => {
    const clusters = [cl(3, ["pkg/dsl/compiler/a.ts", "pkg/dsl/compiler/b.ts", "pkg/dsl/compiler/c.ts"])];
    const topTokens = { "3": ["compiler", "dsl"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.filter((x) => x.cluster_id === 3)).toHaveLength(0);
  });
  it("does NOT flag a label word ending in 'id' that is not a bracketed route param", () => {
    // "grid" ends in "id" but no [grid] segment exists in these paths — must pass clean
    const clusters = [cl(4, ["app/grid/a.ts", "app/grid/b.ts"])];
    const topTokens = { "4": ["grid"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.filter((x) => x.cluster_id === 4)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Route-param extraction — building-block coverage
//
// pickFrameLabel's Pass 1 + Pass 2 both call isLabelEligibleWord, which calls
// params.has(w) to gate out route-param tokens before they can ever reach the
// label. Pass 3 (path-prefix) skips bracketed segments. This means
// checkLabelQuality's `params.has(w)` branch (structural_token_in_label for
// route params) is defense-in-depth: it cannot be triggered by the current
// labeler in production. Rather than constructing a vacuous test that forces
// an impossible code path, we verify the building block that makes both the
// labeler gate AND the checker gate correct: routeParamTokens must extract
// param names accurately from real dynamic-route path shapes.
// ---------------------------------------------------------------------------
describe("routeParamTokens", () => {
  it("extracts a simple bracketed param from member paths", () => {
    const paths = ["a/orgs/[orgId]/settings.ts", "a/orgs/[orgId]/members.ts"];
    const params = routeParamTokens(paths);
    expect(params.has("orgid")).toBe(true);
  });

  it("extracts a rest-param (spread) bracket [...slug]", () => {
    const paths = ["pages/blog/[...slug].vue"];
    const params = routeParamTokens(paths);
    expect(params.has("slug")).toBe(true);
    // The spread syntax prefix must be stripped — "...slug" must NOT appear
    expect(params.has("...slug")).toBe(false);
  });

  it("does NOT extract non-bracketed segments as params", () => {
    const paths = ["app/grid/a.ts", "app/orgs/b.ts"];
    const params = routeParamTokens(paths);
    expect(params.size).toBe(0);
  });

  it("handles mixed paths — only bracketed segments become params", () => {
    const paths = [
      "app/users/[userId]/profile.ts",
      "app/users/shared/utils.ts",
    ];
    const params = routeParamTokens(paths);
    expect(params.has("userid")).toBe(true);
    expect(params.has("shared")).toBe(false);
    expect(params.has("users")).toBe(false);
  });
});
