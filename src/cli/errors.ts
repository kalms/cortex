import { makeStyler, glyphs } from "./style.js";
import { MigrationError } from "../db/migrate.js";

export class UsageError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class DomainError extends Error {
  constructor(message: string, public tip?: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class EnvironmentError extends Error {
  constructor(message: string, public fix?: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

export function exitCodeFor(e: unknown): number {
  if (e instanceof UsageError) return 2;
  if (e instanceof DomainError) return 3;
  if (e instanceof EnvironmentError) return 4;
  if (e instanceof MigrationError) return 4;
  return 1;
}

export function renderError(
  e: unknown,
  stream: { isTTY?: boolean; write(s: string): unknown } = process.stderr,
): void {
  const s = makeStyler(stream);
  const g = glyphs();

  const writeLabel = (msg: string) => {
    stream.write(s.enabled ? `${s.red(s.bold(g.err + " "))}${s.red(msg)}\n` : `ERROR: ${msg}\n`);
  };
  const writeHint = (hint: string, prefix = "") => {
    stream.write(s.enabled ? `\n${s.dim(`${g.arrow} ${prefix}${hint}`)}\n` : `\n${prefix}${hint}\n`);
  };

  if (e instanceof UsageError) {
    writeLabel(e.message);
    if (e.hint) writeHint(e.hint);
    return;
  }
  if (e instanceof DomainError) {
    writeLabel(e.message);
    if (e.tip) writeHint(e.tip);
    return;
  }
  if (e instanceof EnvironmentError) {
    writeLabel(e.message);
    if (e.fix) writeHint(e.fix, "To fix: ");
    return;
  }
  if (e instanceof MigrationError) {
    writeLabel(e.message);
    // store-too-new: a newer plugin wrote a migration this binary doesn't know,
    // so upgrading is the fix. migration-failed: openDecisionsDb already
    // restored the store from its pre-migration snapshot, so "upgrade" is wrong
    // advice — the running version is the one that failed; re-run and report.
    writeHint(
      e.kind === "store-too-new"
        ? "Upgrade the plugin (git pull / npm i -g) to use this store."
        : "The store was restored from its pre-migration snapshot. Re-run the command; if this persists, please report it.",
      "To fix: ",
    );
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  stream.write(
    s.enabled
      ? `${s.red(s.bold(g.err))} ${s.red(msg)}\n  ${s.dim("(run with --debug to see stack)")}\n`
      : `Error: ${msg}\n  (run with --debug to see stack)\n`,
  );
  if (process.env.CORTEX_CLI_DEBUG === "1" && e instanceof Error && e.stack) {
    stream.write(`\n${e.stack}\n`);
  }
}

export async function tryCommand(handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (e) {
    renderError(e);
    process.exit(exitCodeFor(e));
  }
}
