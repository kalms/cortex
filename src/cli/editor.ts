import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "./errors.js";

/**
 * Open the user's editor on a seed `template`, return the edited buffer.
 *
 * Resolves the editor as $VISUAL → $EDITOR → "vi". The editor string is run
 * through a shell so multi-word commands ("code -w", "emacs -nw") work; the
 * temp file path is appended as the final argument. The temp file is always
 * removed, even on throw.
 */
export function openEditor(template: string): string {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const dir = mkdtempSync(join(tmpdir(), "cortex-edit-"));
  const file = join(dir, "CORTEX_EDITMSG");
  try {
    writeFileSync(file, template, "utf-8");
    const res = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
    if (res.error) {
      throw new DomainError(
        `could not launch editor '${editor}': ${res.error.message}`,
        "Set $EDITOR to a valid editor command.",
      );
    }
    if (res.status == null || res.status !== 0) {
      throw new DomainError(
        res.status == null
          ? `editor was killed by signal ${res.signal ?? "unknown"}`
          : "editor exited non-zero — aborted",
        undefined,
      );
    }
    return readFileSync(file, "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
