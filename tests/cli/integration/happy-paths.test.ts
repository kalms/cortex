import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CORTEX = resolve(process.cwd(), "bin/cortex");

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(CORTEX, args, { encoding: "utf-8" });
    return { stdout, stderr: "", code: 0 };
  } catch (e: any) {
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
}

describe("cli integration — happy paths", () => {
  it("--version prints a version", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cortex \d+\.\d+\.\d+/);
  });

  it("--help prints top-level help", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Namespaces:");
    expect(r.stdout).toContain("code");
  });

  it("code --help prints namespace help", () => {
    const r = run(["code", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("search");
  });

  it("help qualified-names prints the topic", () => {
    const r = run(["help", "qualified-names"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("qualified name");
  });

  it("unknown namespace returns code 2", () => {
    const r = run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown namespace");
  });
});
