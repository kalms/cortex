import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { venvDir, venvPythonBin, hasVenv } from "../../src/frame-extraction/venv.js";

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
