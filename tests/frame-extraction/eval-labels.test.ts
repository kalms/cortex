// tests/frame-extraction/eval-labels.test.ts
import { describe, it, expect } from "vitest";
import { checkLabelQuality } from "../../src/frame-extraction/eval-labels.js";
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
  it("flags a bracketed route-param token in the label", () => {
    const clusters = [cl(1, ["a/orgs/[orgId]/x.ts", "a/orgs/[orgId]/y.ts"])];
    const topTokens = { "1": ["orgid design", "design"] };
    const v = checkLabelQuality(clusters, topTokens);
    expect(v.find((x) => x.cluster_id === 1)?.rule).toBe("structural_token_in_label");
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
