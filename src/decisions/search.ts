import { dirname } from "node:path";
import type { Decision } from "./types.js";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository } from "./links-repository.js";

export class DecisionSearch {
  constructor(
    private decisions: DecisionsRepository,
    private links: DecisionLinksRepository,
  ) {}

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

function toDecision(rec: DecisionRecord): Decision {
  return {
    id: rec.id,
    title: rec.title,
    description: rec.description ?? "",
    rationale: rec.rationale ?? "",
    alternatives: rec.alternatives ? JSON.parse(rec.alternatives) : [],
    tier: rec.tier as Decision["tier"],
    status: rec.status as Decision["status"],
    superseded_by: rec.superseded_by,
    author: rec.author ?? "claude",
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    problem: rec.problem,
    resolution: rec.resolution,
  };
}
