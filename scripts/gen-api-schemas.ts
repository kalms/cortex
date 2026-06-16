/**
 * Generate docs/api/<name>.schema.json from the Zod RESPONSE_SCHEMAS
 * (src/mcp-server/api-schemas.ts). Run `npm run gen:api-schemas` after changing
 * a schema; the drift-guard test fails CI if the committed JSON is out of date.
 */
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { RESPONSE_SCHEMAS } from "../src/mcp-server/api-schemas.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "api");

/** Deterministic JSON Schema text for one named schema (stable across runs). */
export function schemaJson(name: string, schema: ZodTypeAny): string {
  const json = zodToJsonSchema(schema, { name, target: "jsonSchema7" });
  return JSON.stringify(json, null, 2) + "\n";
}

export function generateAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(RESPONSE_SCHEMAS)) {
    out[name] = schemaJson(name, schema);
  }
  return out;
}

// Only write to disk when executed directly (not when imported by the test).
const isMain =
  process.argv[1] != null &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, text] of Object.entries(generateAll())) {
    writeFileSync(join(OUT_DIR, `${name}.schema.json`), text);
  }
  console.error(`Wrote ${Object.keys(RESPONSE_SCHEMAS).length} schema files to docs/api/`);
}
