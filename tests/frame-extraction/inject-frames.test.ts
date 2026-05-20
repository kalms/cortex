// tests/frame-extraction/inject-frames.test.ts
import { describe, it, expect } from "vitest";
import {
  pickFrameLabel,
  buildFrameAssignments,
} from "../../scripts/frame-extraction/inject-frames.js";
import type { ClusterResult } from "../../scripts/frame-extraction/types.js";

describe("pickFrameLabel — original behavior", () => {
  it("returns the first non-generic top token", () => {
    expect(pickFrameLabel(["src", "auth", "token"], [])).toBe("auth");
  });

  it("falls back to cluster:<id> when all tokens are generic and no paths help", () => {
    expect(pickFrameLabel(["src", "index", "util"], [], 7)).toBe("cluster:7");
  });

  it("falls back to cluster:<id> when no top tokens at all", () => {
    expect(pickFrameLabel([], [], 3)).toBe("cluster:3");
  });

  it("is case-insensitive in the stop list", () => {
    expect(pickFrameLabel(["SRC", "UTIL", "billing"], [])).toBe("billing");
  });
});

describe("pickFrameLabel — extended stop list", () => {
  it("treats URL/route param tokens as generic (id, slug, params, name)", () => {
    expect(pickFrameLabel(["id", "auth"], [])).toBe("auth");
    expect(pickFrameLabel(["slug", "billing"], [])).toBe("billing");
    expect(pickFrameLabel(["params", "checkout"], [])).toBe("checkout");
    expect(pickFrameLabel(["name", "decisions"], [])).toBe("decisions");
  });

  it("treats runtime/Node globals as generic (dirname, __dirname, __filename)", () => {
    expect(pickFrameLabel(["__dirname", "drizzle"], [])).toBe("drizzle");
    expect(pickFrameLabel(["dirname", "vitest"], [])).toBe("vitest");
    expect(pickFrameLabel(["__filename", "indexer"], [])).toBe("indexer");
  });

  it("treats generic data/state tokens as generic (data, meta, default, props, state)", () => {
    expect(pickFrameLabel(["data", "billing"], [])).toBe("billing");
    expect(pickFrameLabel(["meta", "auth"], [])).toBe("auth");
    expect(pickFrameLabel(["default", "viewer"], [])).toBe("viewer");
    expect(pickFrameLabel(["props", "state", "form"], [])).toBe("form");
  });

  it("treats monorepo-convention dirs as generic (apps, packages)", () => {
    expect(pickFrameLabel(["apps", "dsl"], [])).toBe("dsl");
    expect(pickFrameLabel(["packages", "compiler"], [])).toBe("compiler");
  });

  it("treats short tokens (≤2 chars) as generic regardless of value", () => {
    expect(pickFrameLabel(["ds", "design"], [])).toBe("design");
    expect(pickFrameLabel(["js", "ts", "viewer"], [])).toBe("viewer");
    expect(pickFrameLabel(["a", "b", "c"], [])).not.toBe("a");
  });
});

describe("pickFrameLabel — bigram preference", () => {
  it("prefers a non-generic bigram over a non-generic unigram even at lower rank", () => {
    // 'auth' is the first non-generic unigram, but 'design system' is a better
    // descriptor — bigram with both parts non-generic.
    expect(pickFrameLabel(["auth", "design system"], [])).toBe("design system");
  });

  it("skips bigrams where ANY word is generic", () => {
    // 'system id' has 'id' generic → skip → 'design system' next → return
    expect(pickFrameLabel(["id", "system id", "design system", "auth"], [])).toBe("design system");
  });

  it("falls back to unigram when no fully-non-generic bigram exists", () => {
    // 'system id' has 'id' generic; only unigram 'system' qualifies.
    expect(pickFrameLabel(["id", "system id", "system"], [])).toBe("system");
  });

  it("handles the cortex 'mcp server' case (both words non-generic)", () => {
    expect(pickFrameLabel(["mcp", "mcp server", "server"], [])).toBe("mcp server");
  });

  it("returns 'drizzle config' for the canonical config-files cluster", () => {
    const tokens = [
      "__dirname", "__dirname dirname", "dirname", "config __dirname",
      "config", "drizzle config", "vitest config", "vitest",
    ];
    expect(pickFrameLabel(tokens, [])).toBe("drizzle config");
  });
});

describe("pickFrameLabel — path-prefix fallback", () => {
  it("uses the deepest non-generic common path segment when all tokens are generic", () => {
    const tokens = ["id", "data", "default"];
    const paths = [
      "apps/activator/app/pages/design-system/[id]/colors.vue",
      "apps/activator/app/pages/design-system/[id]/fonts.vue",
      "apps/activator/app/pages/design-system/[id]/templates.vue",
    ];
    // Common path = apps/activator/app/pages/design-system/[id]/
    // Walk back: [id] (URL param, contains brackets) → design-system non-generic → return
    expect(pickFrameLabel(tokens, paths)).toBe("design-system");
  });

  it("falls back to cluster:<id> when no common informative prefix exists", () => {
    const tokens = ["id", "data"];
    const paths = [
      "apps/foo/x.ts",
      "packages/bar/y.ts",
    ];
    // Only '' (split before 'apps' / 'packages') is common — no informative segment
    expect(pickFrameLabel(tokens, paths, 42)).toBe("cluster:42");
  });

  it("skips bracketed path segments like [id] (URL params)", () => {
    const tokens = ["data"];
    const paths = [
      "apps/x/pages/users/[id]/a.vue",
      "apps/x/pages/users/[id]/b.vue",
    ];
    expect(pickFrameLabel(tokens, paths)).toBe("users");
  });
});

describe("buildFrameAssignments — passes paths through to label", () => {
  it("uses path-prefix fallback when all tokens are generic", () => {
    const cluster: ClusterResult = {
      algorithm: "tfidf+hdbscan",
      parameters: {
        top_tokens_per_cluster: {
          "0": ["id", "data", "default"],
        },
      },
      clusters: [{
        cluster_id: 0,
        member_paths: [
          "apps/activator/app/pages/design-system/[id]/a.vue",
          "apps/activator/app/pages/design-system/[id]/b.vue",
        ],
      }],
      total_files: 2,
      noise_count: 0,
    };
    const result = buildFrameAssignments(cluster);
    expect(result[0]?.frame_label).toBe("design-system");
  });
});

describe("buildFrameAssignments", () => {
  const cluster: ClusterResult = {
    algorithm: "tfidf+hdbscan",
    parameters: {
      top_tokens_per_cluster: {
        "0": ["auth", "token"],
        "1": ["billing", "invoice"],
      },
    },
    clusters: [
      { cluster_id: 0, member_paths: ["src/auth/a.ts", "src/auth/b.ts"] },
      { cluster_id: 1, member_paths: ["src/billing/c.ts"] },
      { cluster_id: -1, member_paths: ["src/noise.ts"] },
    ],
    total_files: 4,
    noise_count: 1,
  };

  it("emits one assignment per file in non-noise clusters", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments).toEqual([
      { file_path: "src/auth/a.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0 },
      { file_path: "src/auth/b.ts", frame_id: 0, frame_label: "auth", frame_confidence: 1.0 },
      { file_path: "src/billing/c.ts", frame_id: 1, frame_label: "billing", frame_confidence: 1.0 },
    ]);
  });

  it("does not emit assignments for noise (cluster_id = -1)", () => {
    const assignments = buildFrameAssignments(cluster);
    expect(assignments.some((a) => a.file_path === "src/noise.ts")).toBe(false);
  });

  it("uses cluster:<id> fallback when top_tokens_per_cluster is missing and no informative path prefix", () => {
    const minimalCluster: ClusterResult = {
      ...cluster,
      parameters: {},
      clusters: [{ cluster_id: 5, member_paths: ["src/x.ts"] }],
    };
    const assignments = buildFrameAssignments(minimalCluster);
    // Path = src/x.ts → common prefix is src/ → src is generic → cluster:5
    expect(assignments[0]?.frame_label).toBe("cluster:5");
  });
});
