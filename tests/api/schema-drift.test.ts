import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAll } from "../../scripts/gen-api-schemas.js";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "api");

describe("api schema docs are not stale", () => {
  const generated = generateAll();
  for (const [name, text] of Object.entries(generated)) {
    it(`docs/api/${name}.schema.json matches the Zod source`, () => {
      const committed = readFileSync(join(DOCS, `${name}.schema.json`), "utf8");
      expect(committed).toBe(text); // run `npm run gen:api-schemas` if this fails
    });
  }
});
