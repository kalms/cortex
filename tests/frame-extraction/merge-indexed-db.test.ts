// tests/frame-extraction/merge-indexed-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..", "..", "scripts", "frame-extraction", "merge-indexed-db.ts",
);

function runMerge(args: string[]): { status: number | null; stderr: string } {
  const res = spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf-8" });
  return { status: res.status, stderr: res.stderr ?? "" };
}

describe("merge-indexed-db canonical-target guard", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "cortex-merge-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("refuses to merge into a canonical <repo>/.cortex/db and leaves it untouched", () => {
    const cortexDir = join(tmp, ".cortex");
    mkdirSync(cortexDir);
    const target = join(cortexDir, "db");
    const sentinel = "DO NOT CLOBBER";
    writeFileSync(target, sentinel);
    const source = join(tmp, "src.db"); // need not exist — guard must fire first

    const { status, stderr } = runMerge(
      ["--source", source, "--target", target, "--prefix", "x"],
    );

    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/canonical/);
    // The guard must fire BEFORE any open/write: the target is byte-identical.
    expect(readFileSync(target, "utf-8")).toBe(sentinel);
  });
});
