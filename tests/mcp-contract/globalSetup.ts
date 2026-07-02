import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "cortex-indexer");

export async function setup() {
  // Isolate the master registry so register()-on-index in contract tests does
  // not pollute the user's real ~/.cache/cortex-indexer/_registry.db.
  const regDir = mkdtempSync(join(tmpdir(), "cortex-registry-test-"));
  process.env.CORTEX_REGISTRY_DB = join(regDir, "_registry.db");

  // Isolate the durable decisions store so contract tests write decisions into
  // a temp home rather than the developer's real ~/.cortex.
  const homeDir = mkdtempSync(join(tmpdir(), "cortex-home-test-"));
  process.env.CORTEX_HOME = homeDir;

  if (!existsSync(BINARY)) {
    // In CI a missing binary must fail loudly: skipIf(BINARY_MISSING) would
    // otherwise skip the binary-backed contract suites and the run would still
    // report green. Locally (fresh clone, no prebuilt yet) skipping is fine.
    if (process.env.CI && process.env.CI !== "false") {
      throw new Error(
        `globalSetup: ${BINARY} is missing in CI — refusing to silently skip the MCP-contract suites`
      );
    }
    process.env.CORTEX_CONTRACT_BINARY_MISSING = "1";
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), "cortex-mcp-contract-"));
  const fixtureCopy = join(workDir, "sample-project");
  cpSync(FIXTURE_SRC, fixtureCopy, { recursive: true });

  // Use a fresh cortex.db inside the work dir so each test run is isolated.
  const cortexDbPath = resolve(join(workDir, "cortex.db"));

  const indexResult = execFileSync(
    BINARY,
    ["cli", "index_repository", JSON.stringify({ repo_path: fixtureCopy })],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      encoding: "utf8",
      env: { ...process.env, CORTEX_DB: cortexDbPath },
    }
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

  // Open the cortex.db the indexer just wrote to.
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(cortexDbPath, { readonly: true });
  const row = db
    .prepare("SELECT name FROM ctx_projects WHERE root_path = ?")
    .get(fixtureCopy) as { name: string } | undefined;

  if (!row) {
    db.close();
    throw new Error(`globalSetup: no ctx_projects row found in ${cortexDbPath} for ${fixtureCopy}`);
  }

  const nodeCount = db
    .prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = ?")
    .get(row.name) as { c: number };
  db.close();

  if (nodeCount.c === 0) {
    throw new Error(
      `globalSetup: indexing completed but 0 nodes found for project ${row.name}. ` +
      `Check binary parser support for the fixture's file types.`
    );
  }

  process.env.CORTEX_CONTRACT_FIXTURE_DIR = fixtureCopy;
  process.env.CORTEX_CONTRACT_PROJECT = row.name;
  process.env.CORTEX_CONTRACT_CORTEX_DB = cortexDbPath;
}

export async function teardown() {
  const regDb = process.env.CORTEX_REGISTRY_DB;
  if (regDb) {
    try { rmSync(dirname(regDb), { recursive: true }); } catch { /* ignore */ }
  }

  const homeDir = process.env.CORTEX_HOME;
  if (homeDir) {
    try { rmSync(homeDir, { recursive: true }); } catch { /* ignore */ }
    delete process.env.CORTEX_HOME;
  }

  const fixtureCopy = process.env.CORTEX_CONTRACT_FIXTURE_DIR;
  if (fixtureCopy) {
    // fixtureCopy is at `<workDir>/sample-project`; remove the whole workDir
    // (which also deletes cortex.db sitting alongside it).
    const workDir = dirname(fixtureCopy);
    try { rmSync(workDir, { recursive: true }); } catch { /* ignore */ }
  }
}
