import { describe, it, expect, vi } from "vitest";
import {
  UsageError,
  DomainError,
  EnvironmentError,
  exitCodeFor,
  renderError,
} from "../../src/cli/errors.js";
import { makeStyler } from "../../src/cli/style.js";

describe("errors", () => {
  it("UsageError sets exit code 2", () => {
    const e = new UsageError("missing arg", "Did you mean: cortex code show");
    expect(exitCodeFor(e)).toBe(2);
  });

  it("DomainError sets exit code 3", () => {
    const e = new DomainError("symbol not found", "Try: cortex code find foo");
    expect(exitCodeFor(e)).toBe(3);
  });

  it("EnvironmentError sets exit code 4", () => {
    const e = new EnvironmentError("indexer binary missing", "To fix: npm install");
    expect(exitCodeFor(e)).toBe(4);
  });

  it("unexpected Error sets exit code 1", () => {
    expect(exitCodeFor(new Error("kablooie"))).toBe(1);
  });

  it("renderError writes to stderr (not stdout)", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    renderError(new DomainError("not found", "Try: cortex code find foo"));
    expect(errSpy).toHaveBeenCalled();
    expect(outSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    outSpy.mockRestore();
  });

  it("renderError on DomainError includes the tip block", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    renderError(new DomainError("symbol not found", "Try: cortex code find foo"));
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(joined).toContain("symbol not found");
    expect(joined).toContain("Try: cortex code find foo");
    errSpy.mockRestore();
  });
});

describe("renderError styling", () => {
  function fakeStream(isTTY: boolean) {
    const writes: string[] = [];
    return { writes, isTTY, write(s: string) { writes.push(s); return true; } };
  }

  it("non-TTY stream → plain 'ERROR:' text, no ANSI", () => {
    const s = fakeStream(false);
    renderError(new DomainError("not found", "Try: cortex code find foo"), s);
    const out = s.writes.join("");
    expect(out).toContain("ERROR: not found");
    expect(out).toContain("Try: cortex code find foo");
    expect(out).not.toContain("\x1b");
  });

  it("TTY stream → glyph + arrow + ANSI", () => {
    const s = fakeStream(true);
    renderError(new DomainError("not found", "Try: cortex code find foo"), s);
    const out = s.writes.join("");
    expect(out).toContain("\x1b[");      // colored
    expect(out).toMatch(/[✗X] /);        // error glyph
    expect(out).toContain("not found");
    expect(out).toContain("Try: cortex code find foo");
  });

  it("EnvironmentError keeps the 'To fix:' framing", () => {
    const s = fakeStream(true);
    renderError(new EnvironmentError("indexer missing", "npm install"), s);
    expect(s.writes.join("")).toContain("To fix: npm install");
  });
});
