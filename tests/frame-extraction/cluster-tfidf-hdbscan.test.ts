// tests/frame-extraction/cluster-tfidf-hdbscan.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { runTfIdfHdbscan } from "../../scripts/frame-extraction/cluster-tfidf-hdbscan.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PYTHON_BIN = join(REPO_ROOT, "scripts", "frame-extraction", "python", ".venv", "bin", "python");
const PYTHON_AVAILABLE = existsSync(PYTHON_BIN);

let root: string;

beforeAll(() => {
  if (!PYTHON_AVAILABLE) return;
  // Build a minimal cortex-indexed-looking repo: just the graph DB in
  // .cortex/, populated with two obvious clusters of files (auth + billing).
  // The orchestrator's deriveProjectName takes the absolute repo path,
  // replaces / with -, and trims leading -. We mirror that here so the
  // INSERTed project name matches what the orchestrator will query for.
  const tag = `cortex_cluster_test_${Date.now()}`;
  root = join(tmpdir(), tag);
  // Clean up if a previous run left it behind.
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  const projectName = root.replace(/[/:]/g, "-").replace(/-+/g, "-").replace(/^-+/, "");
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const db = new Database(join(root, ".cortex", "graph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT,
      project TEXT
    );
  `);
  const ins = db.prepare(
    "INSERT INTO nodes (kind, name, file_path, project) VALUES (?, ?, ?, ?)",
  );
  // 6 auth files — strong vocabulary overlap on auth/token/session/login words
  for (let i = 0; i < 6; i++) {
    ins.run("function", `authMiddleware${i}`, `src/auth/middleware_${i}.ts`, projectName);
    ins.run("function", `validateToken${i}`, `src/auth/middleware_${i}.ts`, projectName);
    ins.run("class", `SessionStore${i}`, `src/auth/middleware_${i}.ts`, projectName);
  }
  // 6 billing files — vocabulary overlap on invoice/payment/total/billing
  for (let i = 0; i < 6; i++) {
    ins.run("class", `InvoiceList${i}`, `src/billing/invoice_${i}.ts`, projectName);
    ins.run("function", `computeTotal${i}`, `src/billing/invoice_${i}.ts`, projectName);
    ins.run("function", `processPayment${i}`, `src/billing/invoice_${i}.ts`, projectName);
  }
  db.close();
});

afterAll(() => {
  if (PYTHON_AVAILABLE && root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!PYTHON_AVAILABLE)("runTfIdfHdbscan (requires Python venv)", () => {
  it("clusters auth files and billing files separately", () => {
    const { result } = runTfIdfHdbscan({
      repo_path: root,
      min_cluster_size: 3,
    });

    expect(result.algorithm).toBe("tfidf+hdbscan");
    expect(result.total_files).toBe(12);

    // Expect 2 non-noise clusters. (HDBSCAN's stability can vary; the
    // assertion is loose: at least 2 clusters AND the auth + billing
    // files don't co-mingle.)
    const nonNoise = result.clusters.filter((c) => c.cluster_id !== -1);
    expect(nonNoise.length).toBeGreaterThanOrEqual(2);

    // For every non-noise cluster, all members must share the same
    // top-level directory (src/auth/* or src/billing/*) — i.e. no
    // cluster mixes the two domains.
    for (const cluster of nonNoise) {
      const topDirs = new Set(
        cluster.member_paths.map((p) => p.split("/").slice(0, 2).join("/")),
      );
      expect(topDirs.size).toBe(1);
    }
  });

  it("is deterministic across runs", () => {
    const a = runTfIdfHdbscan({ repo_path: root, min_cluster_size: 3 });
    const b = runTfIdfHdbscan({ repo_path: root, min_cluster_size: 3 });
    // Compare just the result body — out_path / blobs_path are deterministic
    // too (derived from project name) so equality on the full RunResult would
    // also pass, but result is the load-bearing assertion.
    expect(a.result).toEqual(b.result);
  });
});
