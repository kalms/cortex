import { describe, it, expect } from "vitest";
import { stagingDbPath } from "../../src/db/staging-path.js";
import { join } from "node:path";

describe("stagingDbPath", () => {
  it("is a sibling of .cortex/db, pid-scoped, under .cortex/", () => {
    const p = stagingDbPath("/repo", 4242);
    expect(p).toBe(join("/repo", ".cortex", "db.stage-4242"));
  });
  it("defaults to the current pid", () => {
    const p = stagingDbPath("/repo");
    expect(p.startsWith(join("/repo", ".cortex", "db.stage-"))).toBe(true);
  });
});
