import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/db/registry.js";
import { findOrphans, findDeadEntries, isOrphanEntry } from "../../src/db/registry-audit.js";
import { runDoctorCommand } from "../../src/cli/commands/doctor.js";

describe("registry-audit", () => {
  let root: string, sub: string, wt: string, nested: string, nogit: string, dead: string, regDir: string;
  let storeHomeDir: string;
  const savedStoreEnv = { home: process.env.CORTEX_HOME, cache: process.env.CTX_CACHE_DIR };
  beforeAll(() => {
    // runDoctorCommand (Task 6) also audits ~/.cortex and the indexer cache —
    // isolate both so `--fix` in this suite never touches the real user home.
    storeHomeDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-aud-store-")));
    process.env.CORTEX_HOME = storeHomeDir;
    process.env.CTX_CACHE_DIR = join(storeHomeDir, "cache");
    mkdirSync(process.env.CTX_CACHE_DIR, { recursive: true });

    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-aud-")));
    execSync(`git init -q "${root}"`);
    execSync(`git -C "${root}" commit -q --allow-empty -m init`);
    sub = join(root, "docs", "figma");
    mkdirSync(sub, { recursive: true });
    wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-aud-wt-")));
    execSync(`git -C "${root}" worktree add -q "${wt}"`);
    nested = realpathSync(mkdtempSync(join(tmpdir(), "cortex-aud-nested-")));
    execSync(`git init -q "${nested}"`);           // its own root — legit
    nogit = realpathSync(mkdtempSync(join(tmpdir(), "cortex-aud-nogit-"))); // non-git — legit
    dead = join(tmpdir(), "cortex-aud-gone-xyz");   // never created
  });

  afterAll(() => {
    // wt was added as a worktree of root; remove root's git metadata first so
    // no dangling worktree admin dir is left behind, then sweep the temp dirs.
    try {
      execSync(`git -C "${root}" worktree remove --force "${wt}"`);
    } catch {
      // best-effort — fall through to the raw rmSync sweep below regardless
    }
    for (const dir of [root, wt, nested, nogit]) {
      rmSync(dir, { recursive: true, force: true });
    }
    // Isolated registry from the --fix test: drop the env override and its tmp dir.
    delete process.env.CORTEX_REGISTRY_DB;
    if (regDir) rmSync(regDir, { recursive: true, force: true });

    // Restore the store-audit env isolation set up in beforeAll.
    process.env.CORTEX_HOME = savedStoreEnv.home;
    process.env.CTX_CACHE_DIR = savedStoreEnv.cache;
    rmSync(storeHomeDir, { recursive: true, force: true });
  });

  it("flags subdir and worktree entries as orphans; keeps roots, nested repos, non-git", () => {
    expect(isOrphanEntry({ name: "sub", root_path: sub })).toBe(true);
    expect(isOrphanEntry({ name: "wt", root_path: wt })).toBe(true);
    expect(isOrphanEntry({ name: "root", root_path: root })).toBe(false);
    expect(isOrphanEntry({ name: "nested", root_path: nested })).toBe(false);
    expect(isOrphanEntry({ name: "nogit", root_path: nogit })).toBe(false);
  });

  it("findOrphans reports the canonical target", () => {
    const orphans = findOrphans([{ name: "sub", root_path: sub }, { name: "root", root_path: root }]);
    expect(orphans).toEqual([{ name: "sub", root_path: sub, canonical: root }]);
  });

  it("findDeadEntries flags rows whose path is gone", () => {
    const deadEntries = findDeadEntries([{ name: "dead", root_path: dead }, { name: "root", root_path: root }]);
    expect(deadEntries.map((e) => e.name)).toEqual(["dead"]);
  });

  it("runDoctorCommand({ fix: true }) prunes orphan + dead rows, keeps the canonical root", () => {
    regDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-doctor-reg-")));
    process.env.CORTEX_REGISTRY_DB = join(regDir, "registry.db");

    // Seed an isolated registry (Registry honors CORTEX_REGISTRY_DB): a canonical
    // root that must survive, a subdir orphan, and a dead path — the latter two
    // must be pruned. runDoctorCommand opens its own Registry via the same env.
    const seed = new Registry();
    seed.register("survivor", root);
    seed.register("orphan", sub);
    seed.register("gone", dead);
    seed.close();

    runDoctorCommand({ fix: true });

    const after = new Registry();
    const remaining = after.list().map((r) => r.name);
    after.close();

    expect(remaining).toContain("survivor");
    expect(remaining).not.toContain("orphan");
    expect(remaining).not.toContain("gone");
  });
});
