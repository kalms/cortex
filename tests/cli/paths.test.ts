import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, cliVersion, indexerBinPath } from "../../src/cli/paths.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_VERSION = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf-8")).version;

const cwd = process.cwd();
const envRoot = process.env.CORTEX_REPO_ROOT;

afterEach(() => {
  process.chdir(cwd);
  if (envRoot === undefined) delete process.env.CORTEX_REPO_ROOT;
  else process.env.CORTEX_REPO_ROOT = envRoot;
});

describe("repoRoot", () => {
  it("prefers CORTEX_REPO_ROOT when the launcher exported it", () => {
    process.env.CORTEX_REPO_ROOT = "/somewhere/else";
    expect(repoRoot()).toBe("/somewhere/else");
  });

  it("falls back to a module-relative root when the env is unset", () => {
    delete process.env.CORTEX_REPO_ROOT;
    expect(repoRoot()).toBe(REPO);
  });
});

describe("cliVersion", () => {
  it("reports the version from package.json", () => {
    delete process.env.CORTEX_REPO_ROOT;
    expect(cliVersion()).toBe(PKG_VERSION);
  });

  // Regression: getVersion() used to read `<cwd>/package.json`, so the CLI
  // printed "cortex 0.0.0" from any directory without a package.json and —
  // worse — printed an unrelated project's version from any directory with
  // one. The CLI lives on PATH, so cwd is almost never the install root.
  it("is independent of the working directory", () => {
    delete process.env.CORTEX_REPO_ROOT;
    const empty = mkdtempSync(resolve(tmpdir(), "cortex-version-"));
    process.chdir(empty);
    expect(cliVersion()).toBe(PKG_VERSION);

    const foreign = mkdtempSync(resolve(tmpdir(), "cortex-version-"));
    writeFileSync(resolve(foreign, "package.json"), JSON.stringify({ version: "9.9.9" }));
    process.chdir(foreign);
    expect(cliVersion()).toBe(PKG_VERSION);
  });

  it("degrades to 0.0.0 when the root has no readable package.json", () => {
    process.env.CORTEX_REPO_ROOT = mkdtempSync(resolve(tmpdir(), "cortex-version-"));
    expect(cliVersion()).toBe("0.0.0");
  });
});

describe("indexerBinPath", () => {
  it("resolves under the repo root", () => {
    process.env.CORTEX_REPO_ROOT = "/somewhere/else";
    expect(indexerBinPath()).toBe("/somewhere/else/bin/cortex-indexer");
  });
});
