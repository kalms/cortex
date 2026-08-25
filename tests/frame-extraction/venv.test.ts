import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { venvDir, venvPythonBin, hasVenv, setupVenv, ensureVenv } from "../../src/frame-extraction/venv.js";

describe("venv path resolution", () => {
  const orig = process.env.CORTEX_VENV;
  afterEach(() => {
    if (orig === undefined) delete process.env.CORTEX_VENV;
    else process.env.CORTEX_VENV = orig;
  });

  it("defaults to ~/.cache/cortex-indexer/python-venv", () => {
    delete process.env.CORTEX_VENV;
    expect(venvDir()).toBe(join(homedir(), ".cache", "cortex-indexer", "python-venv"));
  });

  it("honors CORTEX_VENV override", () => {
    process.env.CORTEX_VENV = "/tmp/custom-venv";
    expect(venvDir()).toBe("/tmp/custom-venv");
  });

  it("python bin is <venvDir>/bin/python", () => {
    process.env.CORTEX_VENV = "/tmp/custom-venv";
    expect(venvPythonBin()).toBe("/tmp/custom-venv/bin/python");
  });

  it("hasVenv is false when the python bin does not exist", () => {
    process.env.CORTEX_VENV = "/tmp/definitely-not-a-venv-12345";
    expect(hasVenv()).toBe(false);
  });
});

describe("setupVenv", () => {
  const origVenv = process.env.CORTEX_VENV;
  const origPython = process.env.CORTEX_PYTHON;
  afterEach(() => {
    if (origVenv === undefined) delete process.env.CORTEX_VENV; else process.env.CORTEX_VENV = origVenv;
    if (origPython === undefined) delete process.env.CORTEX_PYTHON; else process.env.CORTEX_PYTHON = origPython;
  });

  it("returns python_missing when no python3 can be resolved", () => {
    // Pinning CORTEX_PYTHON, not mangling PATH: resolution now falls back to
    // the usual absolute locations (/usr/bin/python3 &c.) precisely so an
    // empty PATH doesn't defeat it, which would make a PATH-based test build
    // a real venv instead of asserting anything.
    process.env.CORTEX_PYTHON = "/nonexistent-dir-for-test/python3";
    process.env.CORTEX_VENV = "/tmp/venv-should-not-be-created";
    const result = setupVenv({ quiet: true });
    expect(result.status).toBe("python_missing");
    expect(existsSync("/tmp/venv-should-not-be-created")).toBe(false);
  });
});

describe("ensureVenv", () => {
  const origVenv = process.env.CORTEX_VENV;
  const origPython = process.env.CORTEX_PYTHON;
  const origSetup = process.env.CORTEX_FRAMES_SETUP;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "venv-state-"));
    process.env.CORTEX_VENV = join(home, "python-venv");
    // Every test here must be unable to build a real venv: these assert the
    // GUARDS around provisioning, and a genuine pip install would take minutes.
    process.env.CORTEX_PYTHON = join(home, "no-such-python3");
    delete process.env.CORTEX_FRAMES_SETUP;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (origVenv === undefined) delete process.env.CORTEX_VENV; else process.env.CORTEX_VENV = origVenv;
    if (origPython === undefined) delete process.env.CORTEX_PYTHON; else process.env.CORTEX_PYTHON = origPython;
    if (origSetup === undefined) delete process.env.CORTEX_FRAMES_SETUP; else process.env.CORTEX_FRAMES_SETUP = origSetup;
  });

  it("is true and provisions nothing when the venv is already there", () => {
    mkdirSync(join(home, "python-venv", "bin"), { recursive: true });
    writeFileSync(venvPythonBin(), "");
    let provisioned = false;
    expect(ensureVenv({ onProvision: () => { provisioned = true; } })).toBe(true);
    expect(provisioned).toBe(false);
  });

  it("declines without touching anything when CORTEX_FRAMES_SETUP=0", () => {
    process.env.CORTEX_FRAMES_SETUP = "0";
    let provisioned = false;
    expect(ensureVenv({ onProvision: () => { provisioned = true; } })).toBe(false);
    expect(provisioned).toBe(false);
    expect(existsSync(join(home, ".venv-setup-failed"))).toBe(false);
  });

  it("marks a failed setup and does not retry it on the next index", () => {
    let attempts = 0;
    expect(ensureVenv({ onProvision: () => { attempts++; } })).toBe(false);
    expect(attempts).toBe(1);
    expect(existsSync(join(home, ".venv-setup-failed"))).toBe(true);

    // Second call inside the backoff window: no second attempt.
    expect(ensureVenv({ onProvision: () => { attempts++; } })).toBe(false);
    expect(attempts).toBe(1);
  });

  it("leaves no lock behind, so a later run is free to try again", () => {
    ensureVenv();
    expect(existsSync(join(home, ".venv-setup.lock"))).toBe(false);
  });

  it("skips this run while another process holds a fresh lock", () => {
    writeFileSync(join(home, ".venv-setup.lock"), "999999\n");
    let provisioned = false;
    expect(ensureVenv({ onProvision: () => { provisioned = true; } })).toBe(false);
    expect(provisioned).toBe(false);
    // Someone else's lock is not ours to delete.
    expect(existsSync(join(home, ".venv-setup.lock"))).toBe(true);
  });

  it("ignores a stale lock left by a process that died mid-setup", () => {
    const lock = join(home, ".venv-setup.lock");
    writeFileSync(lock, "999999\n");
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lock, hourAgo, hourAgo);
    let provisioned = false;
    ensureVenv({ onProvision: () => { provisioned = true; } });
    expect(provisioned).toBe(true);
  });
});
