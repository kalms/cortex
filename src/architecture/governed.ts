import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { DecisionSearch } from "../decisions/search.js";

/** Active GOVERNS path refs for `root`. Best-effort: [] on any failure. */
export function loadGovernedPaths(root: string): string[] {
  try {
    const ddb = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
    try {
      const search = new DecisionSearch(
        new DecisionsRepository(ddb),
        new DecisionLinksRepository(ddb),
      );
      return search.findGovernedActivePaths();
    } finally {
      ddb.close();
    }
  } catch {
    return [];
  }
}
