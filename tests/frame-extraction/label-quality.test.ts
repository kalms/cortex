// tests/frame-extraction/label-quality.test.ts
import { describe, it, expect } from "vitest";
import { buildCorpusIndex } from "../../src/frame-extraction/label-quality.js";
import type { FileBlob } from "../../src/frame-extraction/types.js";

const blobs: FileBlob[] = [
  { path: "a/auth/login.ts", text: "a auth login authentication session" },
  { path: "a/auth/oauth.ts", text: "a auth oauth authentication token" },
  { path: "a/billing/invoice.ts", text: "a billing invoice payment" },
];

describe("buildCorpusIndex", () => {
  it("indexes lowercased tokens per path and single-term document frequency", () => {
    const idx = buildCorpusIndex(blobs);
    expect(idx.tokensByPath.get("a/auth/login.ts")?.has("authentication")).toBe(true);
    expect(idx.df.get("authentication")).toBe(2); // login.ts + oauth.ts
    expect(idx.df.get("a")).toBe(3);              // all three
    expect(idx.df.get("invoice")).toBe(1);
  });
});

import { scoreLabel } from "../../src/frame-extraction/label-quality.js";

describe("scoreLabel", () => {
  // Corpus: 3 auth files all contain "authentication"; nothing else does.
  const idx = buildCorpusIndex([
    { path: "auth/a.ts", text: "auth a authentication" },
    { path: "auth/b.ts", text: "auth b authentication" },
    { path: "auth/c.ts", text: "auth c authentication" },
    { path: "billing/x.ts", text: "billing x payment" },
    { path: "billing/y.ts", text: "billing y payment" },
  ]);

  it("scores a perfect, distinctive label 1.0", () => {
    const s = scoreLabel("authentication", ["auth/a.ts", "auth/b.ts", "auth/c.ts"], idx);
    expect(s.coverage).toBe(1);
    expect(s.specificity).toBe(1);
    expect(s.f1).toBe(1);
  });

  it("penalises a framework idiom (high coverage, low specificity)", () => {
    // "index" is in all 4 corpus files but the label is applied to a cluster of 2;
    // build a corpus where the term leaks everywhere.
    const leak = buildCorpusIndex([
      { path: "m/1.ts", text: "index one" },
      { path: "m/2.ts", text: "index two" },
      { path: "other/3.ts", text: "index three" },
      { path: "other/4.ts", text: "index four" },
    ]);
    const s = scoreLabel("index", ["m/1.ts", "m/2.ts"], leak);
    expect(s.coverage).toBe(1);        // both members have "index"
    expect(s.specificity).toBe(0.5);   // 2 of 4 corpus files with "index" are members
    expect(s.f1).toBeCloseTo(2 / 3, 5);
  });

  it("penalises a single-member label (low coverage)", () => {
    const s = scoreLabel("payment", ["billing/x.ts", "billing/y.ts", "auth/a.ts"], idx);
    // "payment" in 2 of 3 members, and only those 2 files in the whole corpus.
    expect(s.coverage).toBeCloseTo(2 / 3, 5);
    expect(s.specificity).toBe(1);
    expect(s.f1).toBeCloseTo(0.8, 5);
  });

  it("requires ALL words of a multi-word label (strict AND)", () => {
    const m = buildCorpusIndex([
      { path: "u/1.ts", text: "user model alpha" },
      { path: "u/2.ts", text: "user model beta" },
      { path: "u/3.ts", text: "user only" }, // has "user" but not "model"
    ]);
    const s = scoreLabel("user model", ["u/1.ts", "u/2.ts", "u/3.ts"], m);
    expect(s.coverage).toBeCloseTo(2 / 3, 5); // only 2 contain both words
    expect(s.specificity).toBe(1);
  });

  it("returns zeros when the label appears in no file", () => {
    const s = scoreLabel("nonexistent", ["auth/a.ts"], idx);
    expect(s.coverage).toBe(0);
    expect(s.specificity).toBe(0);
    expect(s.f1).toBe(0);
  });

  it("scores a compound/underscore label via splitSymbol tokenization", () => {
    // Blobs contain the split tokens "method" and "comparison" (produced by
    // splitSymbol("method_comparison") == ["method","comparison"]) but NOT
    // the joined string "method_comparison". The naive whitespace tokenizer
    // would emit ["method_comparison"], which is absent → coverage 0.
    // After the fix (label tokenized with splitSymbol), coverage must be 1.
    const compoundIdx = buildCorpusIndex([
      { path: "train/a.ts", text: "trainer method comparison alpha" },
      { path: "train/b.ts", text: "trainer method comparison beta" },
      { path: "other/c.ts", text: "other stuff here" },
    ]);
    const s = scoreLabel("method_comparison", ["train/a.ts", "train/b.ts"], compoundIdx);
    expect(s.coverage).toBe(1);
    expect(s.f1).toBeGreaterThan(0);
  });
});

import { scoreClusters } from "../../src/frame-extraction/label-quality.js";
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

describe("scoreClusters", () => {
  const idx = buildCorpusIndex([
    { path: "infra/main.tf", text: "infra main tf infrastructure" },
    { path: "infra/net.tf", text: "infra net tf infrastructure" },
    { path: "app/index.ts", text: "app index ts" },
  ]);

  it("scores each non-noise cluster and skips noise (-1)", () => {
    const clusters: ClusterAssignment[] = [
      { cluster_id: 0, member_paths: ["infra/main.tf", "infra/net.tf"] },
      { cluster_id: -1, member_paths: ["app/index.ts"] },
    ];
    const topTokens: Record<string, string[]> = { "0": ["infrastructure"], "-1": ["index"] };
    const scores = scoreClusters(clusters, topTokens, idx);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.cluster_id).toBe(0);
    expect(scores[0]!.member_count).toBe(2);
    expect(scores[0]!.f1).toBeGreaterThan(0);
  });

  it("opaque cluster:N fallback label scores f1=0 (intended: label is not a corpus token)", () => {
    // Corpus contains no token that looks like "cluster" or "cluster:42".
    // With top_tokens=[], pickFrameLabel exhausts all passes and returns
    // "cluster:42" — a string that is absent from every blob token set.
    // Both coverage and f1 should be 0.
    const sparseIdx = buildCorpusIndex([
      { path: "src/a.ts", text: "alpha beta gamma" },
      { path: "src/b.ts", text: "delta epsilon zeta" },
    ]);
    const clusters: ClusterAssignment[] = [
      { cluster_id: 42, member_paths: ["src/a.ts", "src/b.ts"] },
    ];
    const scores = scoreClusters(clusters, { "42": [] }, sparseIdx);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.label).toBe("cluster:42");
    expect(scores[0]!.coverage).toBe(0);
    expect(scores[0]!.f1).toBe(0);
  });
});

import { aggregateLabelQuality } from "../../src/frame-extraction/label-quality.js";
import type { ClusterLabelScore } from "../../src/frame-extraction/label-quality.js";

describe("aggregateLabelQuality", () => {
  const mk = (cluster_id: number, member_count: number, f1: number): ClusterLabelScore => ({
    label: `c${cluster_id}`, terms: [`c${cluster_id}`], coverage: f1, specificity: f1, f1,
    cluster_id, member_count,
  });

  it("computes mean, member-weighted mean, and below-floor count", () => {
    const scores = [mk(0, 1, 1.0), mk(1, 9, 0.0)]; // tiny great cluster, big bad one
    const agg = aggregateLabelQuality(scores, 0.5);
    expect(agg.f1_mean).toBeCloseTo(0.5, 5);          // (1 + 0) / 2
    expect(agg.f1_weighted).toBeCloseTo(0.1, 5);       // (1*1 + 0*9) / 10
    expect(agg.clusters_below).toBe(1);
    expect(agg.cluster_count).toBe(2);
  });

  it("returns zeros for an empty score list", () => {
    const agg = aggregateLabelQuality([], 0.5);
    expect(agg).toEqual({
      f1_mean: 0, f1_weighted: 0, coverage_mean: 0, specificity_mean: 0,
      clusters_below: 0, cluster_count: 0,
    });
  });
});
