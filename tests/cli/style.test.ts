import { describe, it, expect } from "vitest";
import {
  colorEnabled, makeStyler, NO_STYLE, supportsUnicode, glyphs, configureColor,
} from "../../src/cli/style.js";

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

describe("colorEnabled", () => {
  it("auto: enabled on a TTY with a normal TERM", () => {
    expect(colorEnabled(TTY, {}, "auto")).toBe(true);
  });
  it("auto: disabled when not a TTY", () => {
    expect(colorEnabled(PIPE, {}, "auto")).toBe(false);
  });
  it("auto: disabled when TERM=dumb", () => {
    expect(colorEnabled(TTY, { TERM: "dumb" }, "auto")).toBe(false);
  });
  it("NO_COLOR env disables even on a TTY", () => {
    expect(colorEnabled(TTY, { NO_COLOR: "1" }, "auto")).toBe(false);
    expect(colorEnabled(TTY, { NO_COLOR: "" }, "auto")).toBe(false); // any value
  });
  it("CORTEX_NO_COLOR=1 disables", () => {
    expect(colorEnabled(TTY, { CORTEX_NO_COLOR: "1" }, "auto")).toBe(false);
  });
  it("CORTEX_COLOR=always enables on a pipe", () => {
    expect(colorEnabled(PIPE, { CORTEX_COLOR: "always" }, "auto")).toBe(true);
  });
  it("pref=always enables on a pipe", () => {
    expect(colorEnabled(PIPE, {}, "always")).toBe(true);
  });
  it("pref=never beats --color=always env and TTY", () => {
    expect(colorEnabled(TTY, { CORTEX_COLOR: "always" }, "never")).toBe(false);
  });
  it("pref=always beats NO_COLOR env (explicit flag wins)", () => {
    expect(colorEnabled(PIPE, { NO_COLOR: "1" }, "always")).toBe(true);
  });
});

describe("makeStyler", () => {
  it("disabled styler is an exact passthrough", () => {
    const s = makeStyler(PIPE, {}, "never");
    expect(s.enabled).toBe(false);
    expect(s.red("x")).toBe("x");
    expect(s.bold("hi")).toBe("hi");
  });
  it("enabled styler wraps in ANSI", () => {
    const s = makeStyler(TTY, {}, "always");
    expect(s.enabled).toBe(true);
    expect(s.red("x")).toContain("\x1b[");
    expect(s.red("x")).toContain("x");
  });
  it("NO_STYLE is always disabled passthrough", () => {
    expect(NO_STYLE.enabled).toBe(false);
    expect(NO_STYLE.cyan("a")).toBe("a");
  });
});

describe("supportsUnicode / glyphs", () => {
  it("UTF-8 locale → unicode glyphs", () => {
    const env = { LANG: "en_US.UTF-8" };
    expect(supportsUnicode(env)).toBe(true);
    expect(glyphs(env).ok).toBe("✓");
    expect(glyphs(env).err).toBe("✗");
    expect(glyphs(env).arrow).toBe("→");
    expect(glyphs(env).ellipsis).toBe("…");
  });
  it("non-UTF locale → ASCII glyphs", () => {
    const env = { LANG: "C" };
    expect(supportsUnicode(env)).toBe(false);
    expect(glyphs(env).ok).toBe("OK");
    expect(glyphs(env).err).toBe("X");
    expect(glyphs(env).arrow).toBe("->");
    expect(glyphs(env).ellipsis).toBe("...");
  });
  it("CORTEX_ASCII=1 forces ASCII even on UTF-8", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8", CORTEX_ASCII: "1" })).toBe(false);
  });
});

describe("configureColor", () => {
  it("default pref is honored by makeStyler when pref arg omitted", () => {
    configureColor("never");
    expect(makeStyler(TTY).enabled).toBe(false);
    configureColor("always");
    expect(makeStyler(PIPE).enabled).toBe(true);
    configureColor("auto"); // reset for other tests
  });
});

import { spinnerFrames, startSpinner } from "../../src/cli/style.js";

describe("spinnerFrames", () => {
  it("braille frames on UTF-8", () => {
    const f = spinnerFrames({ LANG: "en_US.UTF-8" });
    expect(f).toContain("⠋");
    expect(f.length).toBeGreaterThanOrEqual(8);
  });
  it("ASCII frames on non-UTF", () => {
    expect(spinnerFrames({ LANG: "C" })).toEqual(["|", "/", "-", "\\"]);
  });
});

describe("startSpinner (non-TTY fallback)", () => {
  function fakeStream() {
    const writes: string[] = [];
    return { writes, write(s: string) { writes.push(s); return true; }, isTTY: false };
  }
  it("prints a static start line and a success final line", () => {
    const s = fakeStream();
    const sp = startSpinner("indexing foo", { stream: s, env: { LANG: "en_US.UTF-8" } });
    sp.succeed("indexed foo");
    expect(s.writes.join("")).toBe("… indexing foo\n✓ indexed foo\n");
  });
  it("fail final line uses the err glyph; ASCII when no UTF locale", () => {
    const s = fakeStream();
    const sp = startSpinner("indexing foo", { stream: s, env: { LANG: "C" } });
    sp.fail();
    expect(s.writes.join("")).toBe("... indexing foo\nX indexing foo\n");
  });
  it("does not emit cursor-control codes when not a TTY", () => {
    const s = fakeStream();
    startSpinner("x", { stream: s, env: {} }).stop();
    expect(s.writes.join("")).not.toContain("\x1b");
  });
});
