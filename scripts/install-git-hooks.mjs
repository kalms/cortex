// scripts/install-git-hooks.mjs
// Points git at the committed .githooks/ dir (via core.hooksPath) so the
// post-merge / post-checkout hooks that keep dist/ fresh are active. Run from
// `postinstall`. Best-effort and guarded: silently skips outside a git work
// tree (e.g. an installed npm tarball / plugin install), never fails install.
import { execSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

function run(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

try {
  if (run("git rev-parse --is-inside-work-tree") !== "true") process.exit(0);
} catch {
  process.exit(0); // not a git checkout — nothing to install
}

try {
  run("git config core.hooksPath .githooks");
  // Ensure the hook scripts are executable (a fresh clone may not preserve +x).
  const dir = ".githooks";
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o755);
  console.log("[cortex] git hooks active (core.hooksPath=.githooks) — dist/ auto-rebuilds on pull.");
} catch {
  // Best-effort: a config/chmod failure must not break `npm install`.
}
