import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository, TargetKind, Relation } from "./links-repository.js";

const META_KEY = "migrated_from_graph_db";

interface DecisionNodeRow {
  id: string;
  kind: string;
  name: string;
  data: string;
  tier: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  relation: string;
  created_at: string;
}

interface PathNodeRow {
  id: string;
  file_path: string | null;
  qualified_name: string | null;
}

const RELATION_TARGET_KIND: Record<string, TargetKind> = {
  GOVERNS: "path",          // overridden below if target is a decision/PR/code QN
  REFERENCES: "qn",
  SUPERSEDES: "decision",
  DECISION_RELATED_TO: "decision",
  DECISION_DEPENDS_ON: "decision",
  PR_INTRODUCES_DECISION: "pr",
  PR_IMPLEMENTS_DECISION: "pr",
  PR_CHALLENGES_DECISION: "pr",
  PR_DISCUSSES_DECISION: "pr",
};

export interface MigrationResult { decisions: number; links: number; }

export function migrateDecisionsFromGraphDb(
  decDb: Database.Database,
  graphDbPath: string,
): MigrationResult {
  if (alreadyMigrated(decDb)) return { decisions: 0, links: 0 };
  if (!existsSync(graphDbPath)) {
    markMigrated(decDb);
    return { decisions: 0, links: 0 };
  }

  const g = new Database(graphDbPath, { readonly: true });
  try {
    const decisionNodes = g
      .prepare(`SELECT id, kind, name, data, tier, created_at, updated_at FROM nodes WHERE kind = 'decision'`)
      .all() as DecisionNodeRow[];

    if (decisionNodes.length === 0) {
      markMigrated(decDb);
      return { decisions: 0, links: 0 };
    }

    const decisions = new DecisionsRepository(decDb);
    const links = new DecisionLinksRepository(decDb);
    let migrated = 0;
    let linkCount = 0;

    decDb.transaction(() => {
      for (const node of decisionNodes) {
        const data = safeParseJson(node.data);
        const rec: DecisionRecord = {
          id: node.id,
          title: (data.title as string) ?? node.name ?? "",
          description: (data.description as string | null) ?? null,
          rationale: (data.rationale as string | null) ?? null,
          problem: (data.problem as string | null) ?? null,
          resolution: (data.resolution as string | null) ?? null,
          alternatives: data.alternatives ? JSON.stringify(data.alternatives) : null,
          tier: node.tier ?? "personal",
          status: (data.status as string) ?? "active",
          superseded_by: (data.superseded_by as string | null) ?? null,
          author: (data.author as string | null) ?? null,
          created_at: node.created_at ?? new Date().toISOString(),
          updated_at: node.updated_at ?? new Date().toISOString(),
        };
        decisions.insert(rec);
        migrated++;

        const outgoing = g
          .prepare(`SELECT source_id, target_id, relation, created_at FROM edges WHERE source_id = ?`)
          .all(node.id) as EdgeRow[];
        for (const edge of outgoing) {
          const targetKind = resolveTargetKind(g, edge);
          if (!targetKind) continue;
          const targetRef = resolveTargetRef(g, edge, targetKind);
          if (!targetRef) continue;
          links.add({
            decision_id: node.id,
            target_kind: targetKind,
            target_ref: targetRef,
            relation: edge.relation as Relation,
            created_at: edge.created_at ?? rec.created_at,
          });
          linkCount++;
        }
      }
      markMigrated(decDb);
    })();

    return { decisions: migrated, links: linkCount };
  } finally {
    g.close();
  }
}

function alreadyMigrated(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get(META_KEY) as { value: string } | undefined;
  return row?.value === "true";
}

function markMigrated(db: Database.Database): void {
  db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`).run(META_KEY, "true");
}

function safeParseJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function resolveTargetKind(g: Database.Database, edge: EdgeRow): TargetKind | null {
  const known = RELATION_TARGET_KIND[edge.relation];
  if (!known) return null;
  if (known === "path") {
    // The target may be a path node, a code qn, or another decision depending
    // on caller intent. Inspect the target node to pick the right kind.
    const target = g
      .prepare(`SELECT kind FROM nodes WHERE id = ?`)
      .get(edge.target_id) as { kind: string } | undefined;
    if (!target) return null;
    if (target.kind === "decision") return "decision";
    if (target.kind === "path") return "path";
    return "qn";
  }
  return known;
}

function resolveTargetRef(g: Database.Database, edge: EdgeRow, kind: TargetKind): string | null {
  if (kind === "decision") return edge.target_id;
  if (kind === "pr") {
    const pr = g
      .prepare(`SELECT data FROM nodes WHERE id = ?`)
      .get(edge.target_id) as { data: string } | undefined;
    if (!pr) return null;
    const parsed = safeParseJson(pr.data);
    const num = parsed.number;
    return typeof num === "number" || typeof num === "string" ? String(num) : null;
  }
  // 'path' and 'qn' targets
  const node = g
    .prepare(`SELECT file_path, qualified_name FROM nodes WHERE id = ?`)
    .get(edge.target_id) as PathNodeRow | undefined;
  if (!node) return null;
  if (kind === "path") return node.file_path ?? null;
  return node.qualified_name ?? node.file_path ?? null;
}
