import { existsSync, symlinkSync, unlinkSync, lstatSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EnvironmentError } from "./errors.js";

export type InstallTarget = "symlink" | "alias";

export type DetectInput = {
  home: string;
  path: string;
  localBinExists: boolean;
};

export function detectInstallTarget(input: DetectInput): InstallTarget {
  const dirs = input.path.split(":");
  const localBin = join(input.home, ".local/bin");
  if (input.localBinExists && dirs.includes(localBin)) return "symlink";
  return "alias";
}

function shellRcPath(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("zsh")) return join(homedir(), ".zshrc");
  if (shell.endsWith("fish")) return join(homedir(), ".config/fish/config.fish");
  return join(homedir(), ".bashrc");
}

const ALIAS_MARKER = "# Added by `cortex install`";

export function runInstall(opts: { quiet?: boolean; uninstall?: boolean }): void {
  const repoRoot = resolve(process.cwd());
  const cortexBin = join(repoRoot, "bin/cortex");
  if (!existsSync(cortexBin)) {
    throw new EnvironmentError(
      `bin/cortex not found at ${cortexBin}`,
      "Run this from the cortex repo root.",
    );
  }

  const home = homedir();
  const localBin = join(home, ".local/bin");
  const target = detectInstallTarget({
    home,
    path: process.env.PATH ?? "",
    localBinExists: existsSync(localBin),
  });

  if (opts.uninstall) {
    const symlink = join(localBin, "cortex");
    if (existsSync(symlink) && lstatSync(symlink).isSymbolicLink()) {
      unlinkSync(symlink);
      if (!opts.quiet) process.stdout.write(`removed ${symlink}\n`);
    }
    const rc = shellRcPath();
    if (existsSync(rc)) {
      const content = readFileSync(rc, "utf-8");
      const cleaned = content
        .split("\n")
        .filter((line) => !line.includes(ALIAS_MARKER) && !line.includes(`alias cortex=`))
        .join("\n");
      if (cleaned !== content) {
        writeFileSync(rc, cleaned);
        if (!opts.quiet) process.stdout.write(`updated ${rc}\n`);
      }
    }
    return;
  }

  if (target === "symlink") {
    const symlink = join(localBin, "cortex");
    if (existsSync(symlink) && lstatSync(symlink).isSymbolicLink()) {
      if (!opts.quiet) process.stdout.write(`already installed: ${symlink}\n`);
      return;
    }
    symlinkSync(cortexBin, symlink);
    if (!opts.quiet) process.stdout.write(`installed: ${symlink} → ${cortexBin}\n`);
    return;
  }

  // alias
  const rc = shellRcPath();
  const aliasLine = `alias cortex="${cortexBin}"  ${ALIAS_MARKER}`;
  const existing = existsSync(rc) ? readFileSync(rc, "utf-8") : "";
  if (existing.includes(`alias cortex=`)) {
    if (!opts.quiet) process.stdout.write(`already installed in ${rc}\n`);
    return;
  }
  appendFileSync(rc, `\n${aliasLine}\n`);
  if (!opts.quiet) {
    process.stdout.write(`installed: alias added to ${rc}\n`);
    process.stdout.write(`Open a new terminal or run: source ${rc}\n`);
  }
}
