import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const src = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../src/mcp-server/tools/code-tools.ts"),
  "utf8",
);

describe("code-tools indexer wiring", () => {
  it("no longer references the dead CBM_BINARY_PATH alias", () => {
    expect(src).not.toContain("CBM_BINARY_PATH");
  });
  it("resolves the binary via resolveIndexerBinary", () => {
    expect(src).toContain("resolveIndexerBinary");
  });
});
