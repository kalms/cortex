import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEditor } from "../../src/cli/editor.js";

/** Write a throwaway shell script that overwrites the edit file with `body`,
 *  set it as $EDITOR, and return a cleanup fn. */
function withFakeEditor(body: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cortex-fakeed-"));
  const script = join(dir, "ed.sh");
  // $1 is the path to the edit file passed by openEditor.
  writeFileSync(script, `#!/bin/sh\ncat > "$1" <<'CORTEX_EOF'\n${body}\nCORTEX_EOF\n`, "utf-8");
  chmodSync(script, 0o755);
  const prev = process.env.EDITOR;
  process.env.EDITOR = script;
  return { dir, cleanup: () => { if (prev === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev; rmSync(dir, { recursive: true, force: true }); } };
}

describe("openEditor", () => {
  it("returns the buffer the editor wrote", () => {
    const { cleanup } = withFakeEditor("hello from editor");
    try {
      expect(openEditor("seed template").trim()).toBe("hello from editor");
    } finally { cleanup(); }
  });

  it("throws DomainError when the editor exits non-zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-fakeed-"));
    const script = join(dir, "ed.sh");
    writeFileSync(script, `#!/bin/sh\nexit 1\n`, "utf-8");
    chmodSync(script, 0o755);
    const prev = process.env.EDITOR; process.env.EDITOR = script;
    try {
      expect(() => openEditor("x")).toThrow(/non-zero/);
    } finally {
      if (prev === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts (throws DomainError) when the editor is killed by a signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-fakeed-"));
    const script = join(dir, "ed.sh");
    writeFileSync(script, `#!/bin/sh\nkill -TERM $$\n`, "utf-8");
    chmodSync(script, 0o755);
    const prev = process.env.EDITOR; process.env.EDITOR = script;
    try {
      // A signal-killed editor must abort. How it surfaces through the
      // `shell: true` wrapper is platform-dependent: some shells propagate
      // the signal (spawnSync status === null → "killed by signal N"), others
      // report a non-zero wrapper exit (e.g. 143 → "editor exited non-zero").
      // Both paths abort with a DomainError — assert the abort, not the exact
      // message.
      expect(() => openEditor("x")).toThrow(/killed by signal|exited non-zero/);
    } finally {
      if (prev === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
