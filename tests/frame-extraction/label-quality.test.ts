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
