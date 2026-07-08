import { Registry } from "../../db/registry.js";
import { findOrphans, findDeadEntries, pruneEntries } from "../../db/registry-audit.js";
import { auditStores, fixStores } from "../../db/store-gc-audit.js";

/**
 * `cortex doctor` — audit the project registry for orphan entries (subdirs /
 * worktrees that should collapse to a canonical root, T-119), dead entries
 * (rows whose path no longer exists), and all storage buckets (regenerable
 * caches + orphan decision dirs, Task 6). Dry-run by default; `--fix` removes
 * regenerable copies and registry rows, and archives (never deletes)
 * content-bearing orphan decision dirs.
 */
export function runDoctorCommand(flags: Record<string, string | boolean>): void {
  const fix = flags.fix === true;
  const registry = new Registry();
  try {
    const entries = registry.list();
    const orphans = findOrphans(entries);
    const orphanNames = new Set(orphans.map((o) => o.name));
    const dead = findDeadEntries(entries).filter((e) => !orphanNames.has(e.name));
    const registryClean = orphans.length === 0 && dead.length === 0;

    if (!registryClean) {
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

      if (fix) {
        pruneEntries(registry, [...orphans.map((o) => o.name), ...dead.map((d) => d.name)]);
        process.stdout.write(`\nRemoved ${orphans.length + dead.length} registry row(s).\n`);
      } else {
        process.stdout.write("\nDry run. Re-run with --fix to remove these registry rows.\n");
      }
    }

    const storeAudit = auditStores(registry);
    const storeClean = storeAudit.reapable.length === 0 && storeAudit.archiveCandidates.length === 0;

    if (registryClean && storeClean) {
      process.stdout.write("all clean — no orphan/dead registry entries, no reapable or orphan storage.\n");
      return;
    }

    if (!storeClean) {
      process.stdout.write(`\nRegenerable copies (safe to delete) — ${storeAudit.reapable.length}:\n`);
      for (const r of storeAudit.reapable) process.stdout.write(`  ${r.path}  (${r.reason})\n`);
      if (storeAudit.archiveCandidates.length > 0) {
        process.stdout.write(`\nContent-bearing orphan decision dirs (will ARCHIVE, not delete) — ${storeAudit.archiveCandidates.length}:\n`);
        for (const c of storeAudit.archiveCandidates) process.stdout.write(`  ${c.dir}\n`);
      }

      if (fix) {
        const res = fixStores(registry, storeAudit);
        process.stdout.write(
          `\nReaped ${storeAudit.reapable.length} copies (${res.bytesReaped} bytes); archived ${res.archived.length} decision dir(s) to ~/.cortex/_archive/.\n`,
        );
      } else {
        process.stdout.write("\nDry run. Re-run with --fix to reap regenerable copies and archive orphan decision dirs.\n");
      }
    }
  } finally {
    registry.close();
  }
}
