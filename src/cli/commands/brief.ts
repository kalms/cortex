import type { ProjectContext } from "../context.js";
import type { BriefingDeps } from "../../briefing/types.js";
import { composeBriefing } from "../../briefing/compose.js";
import { buildGateSet, writeGateCache } from "../../briefing/gate-cache.js";
import { resolveGraphDbForRead, resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { DecisionSearch } from "../../decisions/search.js";
import { GraphStore } from "../../graph/store.js";

/** Pure-ish core: compose + map to {headline, exitCode}. Unit-tested. */
export function briefForTarget(
  deps: BriefingDeps,
  target: string,
  opts?: { fanoutThreshold?: number },
): { headline: string; exitCode: number } {
  const b = composeBriefing(deps, target, opts);
  return { headline: b.headline, exitCode: b.escalate ? 2 : 0 };
}

export function runBriefCommand(
  ctx: ProjectContext,
  target: string | null,
  flags?: Record<string, unknown>,
): void {
  if (process.env.CORTEX_BRIEF === "0") return;
  const root = ctx.gitRoot ?? ctx.cwd;
  const graphPath = ctx.graphDbPath ?? resolveGraphDbForRead(root);
  if (!graphPath || !ctx.projectName) return; // unindexed → silent

  // --build-gate-cache mode: build + write the gate cache file, then exit.
  if (flags?.["build-gate-cache"]) {
    const ddb = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
    try {
      const decisions = new DecisionsRepository(ddb);
      const links = new DecisionLinksRepository(ddb);
      const search = new DecisionSearch(decisions, links);
      const store = new GraphStore(graphPath, { readonly: true });
      try {
        const threshold = Number(process.env.CORTEX_BRIEF_FANOUT ?? 12) || 12;
        const entries = buildGateSet({
          decisionsLinks: { findGovernedPaths: () => search.findGovernedActivePaths() },
          store,
          project: ctx.projectName!,
          fanoutThreshold: threshold,
        });
        writeGateCache(root, entries);
      } finally {
        store.close?.();
      }
    } finally {
      ddb.close();
    }
    return;
  }

  if (!target) return;
  const ddb = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  try {
    const decisions = new DecisionsRepository(ddb);
    const links = new DecisionLinksRepository(ddb);
    const search = new DecisionSearch(decisions, links);
    const store = new GraphStore(graphPath, { readonly: true });
    try {
      const threshold = Number(process.env.CORTEX_BRIEF_FANOUT ?? 12) || 12;
      const { headline, exitCode } = briefForTarget(
        { search, decisions, links, store, project: ctx.projectName, repoPath: root },
        target,
        { fanoutThreshold: threshold },
      );
      if (headline) process.stdout.write(headline + "\n");
      process.exitCode = exitCode;
    } finally {
      store.close?.();
    }
  } finally {
    ddb.close();
  }
}
