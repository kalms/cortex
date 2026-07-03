import { dirname } from "node:path";
import type { Decision } from "./types.js";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository } from "./links-repository.js";
import { toDecision } from "./map.js";

export class DecisionSearch {
  constructor(
    private decisions: DecisionsRepository,
    private links: DecisionLinksRepository,
  ) {}

  /**
   * Return DISTINCT path target_refs governed by active decisions only.
   * Filters to: target_kind === "path", relation === "GOVERNS", and the
   * owning decision's status === "active". Used by the gate-cache builder
   * so that superseded/deprecated/proposed decisions never contribute paths.
   */
  findGovernedActivePaths(): string[] {
    // Collect all GOVERNS links of kind "path" across all active decisions.
    const activePaths = new Set<string>();
    for (const rec of this.decisions.list()) {
      if (rec.status !== "active") continue;
      const governLinks = this.links.findByDecision(rec.id).filter(
        (l) => l.relation === "GOVERNS" && l.target_kind === "path",
      );
      for (const l of governLinks) {
        activePaths.add(l.target_ref);
      }
    }
    return Array.from(activePaths);
  }

  /** Return all decisions whose GOVERNS link matches `target` or any of its
   *  ancestor paths. Walks up '/' separators in `target` until a hit lands. */
  findGoverning(target: string): Decision[] {
    // 1. Exact match as qn.
    let hits = this.links.findByTarget("qn", target, "GOVERNS");

    // 2. Exact match as path.
    if (hits.length === 0) hits = this.links.findByTarget("path", target, "GOVERNS");

    // 3. Strip the trailing "::member" if present and try the file portion.
    if (hits.length === 0 && target.includes("::")) {
      const file = target.slice(0, target.indexOf("::"));
      hits = this.links.findByTarget("path", file, "GOVERNS");
    }

    // 4. Walk up directories.
    if (hits.length === 0) {
      let dir = dirname(stripQnMember(target));
      while (dir && dir !== "." && dir !== "/") {
        const dirHits = this.links.findByTarget("path", dir, "GOVERNS");
        if (dirHits.length > 0) { hits = dirHits; break; }
        const next = dirname(dir);
        if (next === dir) break;
        dir = next;
      }
    }

    if (hits.length === 0) return [];
    return hits
      .map((h) => this.decisions.get(h.decision_id))
      .filter((r): r is DecisionRecord => r !== null)
      .map(toDecision);
  }
}

function stripQnMember(target: string): string {
  const i = target.indexOf("::");
  return i === -1 ? target : target.slice(0, i);
}
