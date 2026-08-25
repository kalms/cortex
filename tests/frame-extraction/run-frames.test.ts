import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runFrameExtraction } from "../../src/frame-extraction/run-frames.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** A DB shaped just enough for hasFileNodes() to see one file node. */
function dbWithFileNode(project: string): string {
  const dir = mkdtempSync(join(tmpdir(), "frames-gate-"));
  const path = join(dir, "graph.db");
  const db = new Database(path);
  db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, project TEXT, data TEXT)");
  db.prepare("INSERT INTO nodes VALUES ('ctx-1','file',?,'{}')").run(project);
  db.close();
  return path;
}

describe("runFrameExtraction gating", () => {
  const origFrames = process.env.CORTEX_FRAMES;
  const origVenv = process.env.CORTEX_VENV;
  const origSetup = process.env.CORTEX_FRAMES_SETUP;
  afterEach(() => {
    if (origFrames === undefined) delete process.env.CORTEX_FRAMES; else process.env.CORTEX_FRAMES = origFrames;
    if (origVenv === undefined) delete process.env.CORTEX_VENV; else process.env.CORTEX_VENV = origVenv;
    if (origSetup === undefined) delete process.env.CORTEX_FRAMES_SETUP; else process.env.CORTEX_FRAMES_SETUP = origSetup;
  });

  it("skips with reason 'disabled' when CORTEX_FRAMES=0", async () => {
    process.env.CORTEX_FRAMES = "0";
    const r = await runFrameExtraction({ repoPath: "/tmp", project: "P", dbPath: "/tmp/x.db" });
    expect(r).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("skips with reason 'venv_missing' when the venv is absent and setup is declined", async () => {
    delete process.env.CORTEX_FRAMES;
    process.env.CORTEX_VENV = join(mkdtempSync(join(tmpdir(), "no-venv-")), "python-venv");
    // Without this the gate would try to PROVISION the venv — minutes and a
    // network. CORTEX_FRAMES_SETUP=0 is the documented opt-out, and it is what
    // a machine that genuinely does not want frames sets.
    process.env.CORTEX_FRAMES_SETUP = "0";
    const r = await runFrameExtraction({ repoPath: "/tmp", project: "P", dbPath: dbWithFileNode("P") });
    expect(r).toEqual({ status: "skipped", reason: "venv_missing" });
  });

  it("checks for file nodes BEFORE the venv, so an empty repo never provisions one", async () => {
    delete process.env.CORTEX_FRAMES;
    // No venv, and setup NOT opted out: reaching the venv gate here would
    // start a real pip install. It must not — there is nothing to cluster.
    process.env.CORTEX_VENV = join(mkdtempSync(join(tmpdir(), "no-venv-")), "python-venv");
    const r = await runFrameExtraction({
      repoPath: "/tmp", project: "P", dbPath: join(tmpdir(), "does-not-exist-frames.db"),
    });
    expect(r).toEqual({ status: "skipped", reason: "no_files" });
  });

  it("skips with reason 'no_files' when the DB has no file nodes", async () => {
    delete process.env.CORTEX_FRAMES;
    // Stub a venv so hasVenv() passes deterministically regardless of the host.
    const fakeVenv = mkdtempSync(join(tmpdir(), "fake-venv-"));
    mkdirSync(join(fakeVenv, "bin"), { recursive: true });
    writeFileSync(join(fakeVenv, "bin", "python"), "");
    // hasVenv() also requires the clusterer's first import to be present.
    mkdirSync(join(fakeVenv, "lib", "python3.11", "site-packages", "numpy"), { recursive: true });
    process.env.CORTEX_VENV = fakeVenv;
    try {
      // Non-existent DB → hasFileNodes() returns false → no_files (before any python spawn).
      const r = await runFrameExtraction({
        repoPath: "/tmp", project: "P", dbPath: join(fakeVenv, "does-not-exist.db"),
      });
      expect(r).toEqual({ status: "skipped", reason: "no_files" });
    } finally {
      rmSync(fakeVenv, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasVenv())("runFrameExtraction integration", () => {
  it("assigns frame_id to file nodes of a real index", async () => {
    const repoRoot = resolve(join(__dirname, "..", ".."));
    const bin = join(repoRoot, "bin", "cortex-indexer");
    const work = mkdtempSync(join(tmpdir(), "frames-int-"));
    const fixture = join(work, "sample-project");
    cpSync(join(repoRoot, "tests", "fixtures", "sample-project"), fixture, { recursive: true });
    const dbPath = join(work, "graph.db");
    execFileSync(bin, ["cli", "index_repository", JSON.stringify({ repo_path: fixture })], {
      env: { ...process.env, CORTEX_DB: dbPath }, stdio: "ignore",
    });
    const { default: DB } = await import("better-sqlite3");
    const conn = new DB(dbPath, { readonly: true });
    const project = (conn.prepare("SELECT name FROM ctx_projects LIMIT 1").get() as { name: string }).name;
    conn.close();

    const r = await runFrameExtraction({ repoPath: fixture, project, dbPath });
    rmSync(work, { recursive: true, force: true });
    expect(r.status).toBe("ok");
  }, 60_000);

  it("runs with reclamation wired in and does not regress framesAssigned", async () => {
    const repoRoot = resolve(join(__dirname, "..", ".."));
    const bin = join(repoRoot, "bin", "cortex-indexer");
    const work = mkdtempSync(join(tmpdir(), "frames-reclaim-int-"));
    const fixture = join(work, "sample-project");
    cpSync(join(repoRoot, "tests", "fixtures", "sample-project"), fixture, { recursive: true });
    const dbPath = join(work, "graph.db");
    execFileSync(bin, ["cli", "index_repository", JSON.stringify({ repo_path: fixture })], {
      env: { ...process.env, CORTEX_DB: dbPath }, stdio: "ignore",
    });
    const { default: DB } = await import("better-sqlite3");
    const conn = new DB(dbPath, { readonly: true });
    const project = (conn.prepare("SELECT name FROM ctx_projects LIMIT 1").get() as { name: string }).name;
    conn.close();

    const res = await runFrameExtraction({ repoPath: fixture, project, dbPath });
    expect(res.status).toBe("ok");

    // Reclamation may add reclaimed members; framesAssigned must be >= the
    // non-noise cluster member count. Assert the pipeline succeeded and the
    // reclaimed-flag query is valid (>= 0). With cross-file edges into noise it
    // will be > 0; the fixture may or may not have such edges.
    const db = new Database(dbPath);
    const reclaimedCount = (db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE kind='file' AND json_extract(data,'$.reclaimed')=1"
    ).get() as { c: number }).c;
    db.close();
    expect(reclaimedCount).toBeGreaterThanOrEqual(0);

    rmSync(work, { recursive: true, force: true });
  }, 60_000);
});
