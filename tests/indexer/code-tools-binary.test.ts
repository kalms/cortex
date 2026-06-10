import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const src = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../src/mcp-server/tools/code-tools.ts"),
  "utf8",
);

describe("code-tools indexer wiring", () => {
  it("resolves the binary via the ensureIndexer guard", () => {
    expect(src).toContain("ensureIndexer");
  });
});
