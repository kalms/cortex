import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";

describe("GraphStore busy_timeout", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("opens with a non-zero busy_timeout", () => {
    dir = mkdtempSync(join(tmpdir(), "gs-busy-"));
    const store = new GraphStore(join(dir, "db"));
    const [{ timeout }] = store.queryRaw<{ timeout: number }>("PRAGMA busy_timeout", []);
    store.close();
    expect(timeout).toBeGreaterThanOrEqual(5000);
  });
});
