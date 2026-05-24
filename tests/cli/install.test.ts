import { describe, it, expect } from "vitest";
import { detectInstallTarget } from "../../src/cli/install.js";

describe("install — detection", () => {
  it("detectInstallTarget returns 'symlink' when ~/.local/bin is on PATH", () => {
    const target = detectInstallTarget({ home: "/home/test", path: "/usr/bin:/home/test/.local/bin", localBinExists: true });
    expect(target).toBe("symlink");
  });

  it("detectInstallTarget returns 'alias' when ~/.local/bin is not on PATH", () => {
    const target = detectInstallTarget({ home: "/home/test", path: "/usr/bin", localBinExists: true });
    expect(target).toBe("alias");
  });

  it("detectInstallTarget returns 'alias' when ~/.local/bin does not exist", () => {
    const target = detectInstallTarget({ home: "/home/test", path: "/usr/bin:/home/test/.local/bin", localBinExists: false });
    expect(target).toBe("alias");
  });
});
