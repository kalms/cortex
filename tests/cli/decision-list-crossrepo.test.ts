/**
 * CLI parity for P5 cross-repo decision search (D-hajs):
 * `cortex decision list --cross-repo [--query=…]` fans out over the master
 * registry and prints flat rows with a `repo` column — addressed repo first.
 *
 * Isolation: CORTEX_HOME redirects the durable ~/.cortex store and
 * CORTEX_REGISTRY_DB redirects the registry, so the user's real state is
 * never read or written. (CORTEX_DECISIONS_DB is deliberately NOT used —
 * it collapses every repo to one DB, which defeats cross-repo semantics.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/db/registry.js";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

let repoA: string;
let repoB: string;
let ghostPath: string;
let isolationDir: string;
let env: NodeJS.ProcessEnv;

function makeRepo(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

function cli(cwd: string, args: string[]): string {
  return execFileSync(TSX, [CLI, ...args], { cwd, encoding: "utf-8", env });
}

describe("cortex decision list --cross-repo", () => {
  beforeAll(() => {
    isolationDir = mkdtempSync(join(tmpdir(), "cortex-cli-xrepo-home-"));
    repoA = makeRepo("cortex-cli-xrepo-A-");
    repoB = makeRepo("cortex-cli-xrepo-B-");
    ghostPath = join(isolationDir, "no-such-repo");

    env = {
      ...process.env,
      CORTEX_HOME: isolationDir,
      CORTEX_REGISTRY_DB: join(isolationDir, "registry.db"),
    };
    delete env.CORTEX_DECISIONS_DB;

    const registry = new Registry(join(isolationDir, "registry.db"));
    registry.register("xrepo-fixture-b", repoB);
    registry.register("xrepo-fixture-ghost", ghostPath);
    registry.close();

    cli(repoA, ["decision", "create", "--title=Use alphastore engine",
      "--description=alphastore is the engine", "--rationale=fits"]);
    cli(repoB, ["decision", "create", "--title=Use betastore engine",
      "--description=betastore is the engine", "--rationale=fits"]);
  });

  afterAll(() => {
    for (const p of [repoA, repoB, isolationDir]) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("finds a repo-B decision from repo A with --cross-repo --query", () => {
    const out = cli(repoA, ["decision", "list", "--cross-repo", "--query=betastore", "--format=json"]);
    const rows = JSON.parse(out);
    expect(rows.length).toBe(1);
    expect(rows[0].repo).toBe("xrepo-fixture-b");
    expect(rows[0].title).toContain("betastore");
  });

  it("without --cross-repo the same query finds nothing (single-repo)", () => {
    const out = cli(repoA, ["decision", "list", "--query=betastore", "--format=json"]);
    expect(JSON.parse(out)).toEqual([]);
  });

  it("addressed repo's rows come first when both repos match", () => {
    const out = cli(repoA, ["decision", "list", "--cross-repo", "--query=engine", "--format=json"]);
    const rows = JSON.parse(out);
    expect(rows.length).toBe(2);
    expect(rows[0].title).toContain("alphastore");
    expect(rows[1].repo).toBe("xrepo-fixture-b");
  });

  it("works without --query (lists everything, grouped by repo column)", () => {
    const out = cli(repoA, ["decision", "list", "--cross-repo", "--format=json"]);
    const rows = JSON.parse(out);
    expect(rows.length).toBe(2);
    expect(rows.every((r: { repo: string }) => typeof r.repo === "string")).toBe(true);
  });

  it("reports unreachable registry rows on stderr, never fails the command", () => {
    const res = spawnSync(TSX, [CLI, "decision", "list", "--cross-repo", "--query=engine", "--format=json"], {
      cwd: repoA, encoding: "utf-8", env,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("betastore");
    // The ghost row is surfaced as a stderr note — stdout stays parseable.
    expect(res.stderr).toContain("xrepo-fixture-ghost");
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });
});
