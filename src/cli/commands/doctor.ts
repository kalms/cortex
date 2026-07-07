import { Registry } from "../../db/registry.js";
import { findOrphans, findDeadEntries, pruneEntries } from "../../db/registry-audit.js";

/**
 * `cortex doctor` — audit the project registry for orphan entries (subdirs /
 * worktrees that should collapse to a canonical root, T-119) and dead entries
 * (rows whose path no longer exists). Dry-run by default; `--fix` removes them.
 */
export function runDoctorCommand(flags: Record<string, string | boolean>): void {
  const fix = flags.fix === true;
  const registry = new Registry();
  try {
    const entries = registry.list();
    const orphans = findOrphans(entries);
    const orphanNames = new Set(orphans.map((o) => o.name));
    const dead = findDeadEntries(entries).filter((e) => !orphanNames.has(e.name));

    if (orphans.length === 0 && dead.length === 0) {
      process.stdout.write("registry clean — no orphan or dead entries.\n");
      return;
    }

    if (orphans.length > 0) {
      process.stdout.write(`Orphan entries (collapse to a canonical root) — ${orphans.length}:\n`);
      for (const o of orphans) {
        process.stdout.write(`  ${o.name}\n    at:        ${o.root_path}\n    canonical: ${o.canonical}\n`);
      }
    }
    if (dead.length > 0) {
      process.stdout.write(`Dead entries (path missing) — ${dead.length}:\n`);
      for (const d of dead) process.stdout.write(`  ${d.name}\n    at: ${d.root_path}\n`);
    }

    if (!fix) {
      process.stdout.write("\nDry run. Re-run with --fix to remove these registry rows.\n");
      return;
    }

    pruneEntries(registry, [...orphans.map((o) => o.name), ...dead.map((d) => d.name)]);
    process.stdout.write(`\nRemoved ${orphans.length + dead.length} registry row(s).\n`);
  } finally {
    registry.close();
  }
}
