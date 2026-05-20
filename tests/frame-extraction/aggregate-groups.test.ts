// tests/frame-extraction/aggregate-groups.test.ts
import { describe, it, expect } from "vitest";
import {
  groupAuxiliaryPaths,
  type Aggregate,
} from "../../scripts/frame-extraction/auxiliary-detection.js";

describe("groupAuxiliaryPaths", () => {
  it("groups paths by the segment immediately after the auxiliary segment", () => {
    const paths = [
      "internal/indexer/vendored/lz4/compress.c",
      "internal/indexer/vendored/lz4/decompress.c",
      "internal/indexer/vendored/yyjson/yyjson.c",
    ];
    const result = groupAuxiliaryPaths(paths);
    expect(result).toHaveLength(2);

    const lz4 = result.find((a) => a.label === "lz4");
    const yyjson = result.find((a) => a.label === "yyjson");
    expect(lz4?.member_count).toBe(2);
    expect(lz4?.aux_segment).toBe("vendored");
    expect(yyjson?.member_count).toBe(1);
  });

  it("uses the auxiliary segment as label when no sub-directory exists", () => {
    const result = groupAuxiliaryPaths(["dist/bundle.js", "dist/style.css"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("dist");
    expect(result[0]?.aux_segment).toBe("dist");
    expect(result[0]?.member_count).toBe(2);
  });

  it("assigns stable ids of the form aux:<segment>:<label>", () => {
    const result = groupAuxiliaryPaths([
      "internal/indexer/vendored/lz4/compress.c",
    ]);
    expect(result[0]?.id).toBe("aux:vendored:lz4");
  });

  it("sorts aggregates by member_count desc, then label asc", () => {
    const paths = [
      "vendor/a/one.js",     // a: 1
      "vendor/b/one.js",     // b: 3
      "vendor/b/two.js",
      "vendor/b/three.js",
      "vendor/c/one.js",     // c: 2
      "vendor/c/two.js",
    ];
    const result = groupAuxiliaryPaths(paths);
    expect(result.map((a) => a.label)).toEqual(["b", "c", "a"]);
  });

  it("returns sample_paths capped at 5 (first encountered, deterministic)", () => {
    const paths = Array.from({ length: 10 }, (_, i) => `dist/file-${i}.js`);
    const result = groupAuxiliaryPaths(paths);
    expect(result[0]?.member_count).toBe(10);
    expect(result[0]?.sample_paths).toHaveLength(5);
    expect(result[0]?.sample_paths[0]).toBe("dist/file-0.js");
  });

  it("ignores non-auxiliary paths (only aggregates known aux segments)", () => {
    const result = groupAuxiliaryPaths([
      "src/auth/middleware.ts",
      "internal/indexer/vendored/lz4/compress.c",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("lz4");
  });

  it("uses the FIRST matching auxiliary segment in the path", () => {
    // If a path somehow had two aux segments, group by the first one.
    // (Unusual; this is a safety property.)
    const result = groupAuxiliaryPaths(["packages/vendor/lib/dist/foo.js"]);
    // First aux segment encountered is 'vendor', next segment is 'lib'.
    expect(result[0]?.aux_segment).toBe("vendor");
    expect(result[0]?.label).toBe("lib");
  });

  it("accepts a custom segments set", () => {
    const result = groupAuxiliaryPaths(
      ["thirdparty/foo/bar.js", "thirdparty/baz/qux.js"],
      new Set(["thirdparty"]),
    );
    expect(result[0]?.aux_segment).toBe("thirdparty");
    expect(result.map((a) => a.label).sort()).toEqual(["baz", "foo"]);
  });

  it("returns empty array for empty input", () => {
    expect(groupAuxiliaryPaths([])).toEqual([]);
  });

  it("is deterministic — same input gives same output (including sample_paths order)", () => {
    const paths = [
      "vendor/x/c.js",
      "vendor/x/a.js",
      "vendor/x/b.js",
    ];
    const a = groupAuxiliaryPaths(paths);
    const b = groupAuxiliaryPaths(paths);
    expect(a).toEqual(b);
    // Input order is preserved (not re-sorted): caller controls determinism.
    expect(a[0]?.sample_paths).toEqual(["vendor/x/c.js", "vendor/x/a.js", "vendor/x/b.js"]);
  });
});

// Type export sanity check
describe("Aggregate type", () => {
  it("has the expected shape", () => {
    const a: Aggregate = {
      id: "aux:vendored:lz4",
      label: "lz4",
      aux_segment: "vendored",
      member_count: 2,
      sample_paths: ["a", "b"],
    };
    expect(a).toBeDefined();
  });
});
