// tests/frame-extraction/derive-project-name.test.ts
//
// Lock in byte-equivalence with the C indexer's `ctx_project_name_from_path`.
// These cases are ported directly from internal/indexer/tests/test_fqn.c —
// any divergence here means the orchestrator looks up a different `project`
// column than the indexer wrote into the graph DB, which silently produces
// zero clusters.
import { describe, it, expect } from "vitest";
import { deriveProjectName } from "../../scripts/frame-extraction/cluster-tfidf-hdbscan.js";

describe("deriveProjectName — C-indexer parity", () => {
  it("project_name_unix_path", () => {
    expect(deriveProjectName("/Users/dev/my-project")).toBe("Users-dev-my-project");
  });

  it("project_name_windows_path", () => {
    expect(deriveProjectName("C:\\Users\\dev\\project")).toBe("C-Users-dev-project");
  });

  it("project_name_with_colons", () => {
    expect(deriveProjectName("C:/dev/proj")).toBe("C-dev-proj");
  });

  it("project_name_multiple_slashes", () => {
    expect(deriveProjectName("/home///user//code")).toBe("home-user-code");
  });

  it("project_name_leading_trailing_slashes", () => {
    expect(deriveProjectName("/foo/bar/")).toBe("foo-bar");
  });

  it("project_name_empty", () => {
    expect(deriveProjectName("")).toBe("root");
  });

  it("project_name_all_slashes", () => {
    expect(deriveProjectName("///")).toBe("root");
  });

  it("project_name_single_segment", () => {
    expect(deriveProjectName("myproject")).toBe("myproject");
  });

  it("project_name_mixed_separators", () => {
    expect(deriveProjectName("C:\\Users/dev:proj")).toBe("C-Users-dev-proj");
  });

  it("project_name_already_dashed (single dashes preserved)", () => {
    expect(deriveProjectName("/my-great-project")).toBe("my-great-project");
  });

  it("project_name_deep_path", () => {
    expect(deriveProjectName("/a/b/c/d/e/f/g")).toBe("a-b-c-d-e-f-g");
  });
});
