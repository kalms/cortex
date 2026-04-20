import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { discoverCbmDb } from "../../src/graph/cbm-discovery.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "codebase-memory-mcp");

export async function setup() {
  if (!existsSync(BINARY)) {
    // CI without the binary — contract suite will fail when harness is used; that's expected.
    // We deliberately do not silently skip here; absence of binary is a deploy-time concern.
    process.env.CORTEX_CONTRACT_BINARY_MISSING = "1";
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "cortex-mcp-contract-"));
  const fixtureCopy = join(workDir, "sample-project");
  cpSync(FIXTURE_SRC, fixtureCopy, { recursive: true });

  const indexResult = execFileSync(
    BINARY,
    ["cli", "index_repository", JSON.stringify({ repo_path: fixtureCopy })],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, encoding: "utf8" }
  );

  // The binary always exits 0. Check for isError in JSON output.
  let parsed: { content?: Array<{ text?: string }>; isError?: boolean };
  try {
    parsed = JSON.parse(indexResult);
  } catch {
    throw new Error(
      `globalSetup: index_repository produced non-JSON output: ${indexResult.slice(0, 500)}`
    );
  }
  if (parsed.isError) {
    throw new Error(
      `globalSetup: index_repository failed: ${parsed.content?.[0]?.text ?? indexResult}`
    );
  }

  const cbmDbPath = discoverCbmDb(fixtureCopy);
  if (!cbmDbPath) {
    throw new Error(`globalSetup: discoverCbmDb could not find DB for ${fixtureCopy} after indexing.`);
  }

  // Derive project name from the attached DB.
  // Open the DB briefly to read the project name for this root_path.
  // (We can't use GraphStore here to avoid an import cycle in globalSetup; use better-sqlite3 directly.)
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(cbmDbPath, { readonly: true });
  const row = db.prepare("SELECT name FROM projects WHERE root_path = ?").get(fixtureCopy) as { name: string } | undefined;

  if (!row) {
    db.close();
    throw new Error(`globalSetup: no project row found in ${cbmDbPath} for ${fixtureCopy}`);
  }

  const nodeCount = db.prepare(
    "SELECT COUNT(*) AS c FROM nodes WHERE project = ?"
  ).get(row.name) as { c: number };
  db.close();

  if (nodeCount.c === 0) {
    throw new Error(
      `globalSetup: indexing completed but 0 nodes found for project ${row.name}. ` +
      `Check binary parser support for the fixture's file types.`
    );
  }

  process.env.CORTEX_CONTRACT_FIXTURE_DIR = fixtureCopy;
  process.env.CORTEX_CONTRACT_PROJECT = row.name;
  process.env.CORTEX_CONTRACT_CBM_DB = cbmDbPath;
}

export async function teardown() {
  const dbPath = process.env.CORTEX_CONTRACT_CBM_DB;
  if (dbPath) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try { rmSync(dbPath + suffix); } catch { /* may not exist */ }
    }
  }
  const fixtureCopy = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
  if (fixtureCopy) {
    try { rmSync(fixtureCopy, { recursive: true }); } catch { /* ignore */ }
  }
}
