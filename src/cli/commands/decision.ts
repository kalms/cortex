import { existsSync } from "node:fs";
import { basename } from "node:path";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
import { Registry } from "../../db/registry.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { DecisionService } from "../../decisions/service.js";
import { DecisionSearch } from "../../decisions/search.js";
import { frameCandidates } from "../../decisions/seed/frame-candidates.js";
import { captureOrigin, type OriginFields } from "../../git/origin.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import { writeRows, chooseFormat } from "../format.js";
import { cmdRehome } from "./decision-rehome.js";

export type DecisionCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function openService(ctx: ProjectContext) {
  // Decisions db sits next to the graph db. Require a git repo so we don't
  // scatter .cortex/ directories under random working dirs (e.g. when the
  // user runs `cortex decision list` from $HOME).
  if (ctx.state === "no-project") {
    throw new EnvironmentError(
      "decisions require a git repository — cd into a repo first",
      "cortex tour    to see what's available without a project",
    );
  }
  const root = ctx.gitRoot ?? ctx.cwd;
  const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  const links = new DecisionLinksRepository(db);
  const svc = new DecisionService({
    db,
    decisions: new DecisionsRepository(db),
    links,
  });
  // captureOrigin is called HERE, once, in the CLI command layer (never in
  // DecisionService, which stays free of git imports) — every mutating CLI
  // call below threads this same capture into its service call.
  const origin: OriginFields = captureOrigin(root);
  return { db, svc, links, origin };
}

function requireFlag(name: string, flags: Record<string, unknown>): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new UsageError(
      `missing --${name}`,
      `Usage: cortex decision create --title=... --description=... --rationale=...`,
    );
  }
  return v;
}

function cmdCandidates(cmd: DecisionCommand, ctx: ProjectContext): void {
  if (ctx.state === "no-project") {
    throw new EnvironmentError(
      "decision candidates require a git repository — cd into a repo first",
      "cortex tour    to see what's available without a project",
    );
  }
  const rawMax = typeof cmd.flags["max"] === "string" ? Number(cmd.flags["max"]) : undefined;
  if (rawMax !== undefined && !Number.isFinite(rawMax)) {
    throw new UsageError(
      `--max must be a positive integer (got: ${cmd.flags["max"]})`,
      "Example: cortex decision candidates --max=10",
    );
  }
  const max = rawMax;
  const base = typeof cmd.flags["base"] === "string" && cmd.flags["base"].length > 0
    ? cmd.flags["base"]
    : undefined;
  // repo_path must be the git root, not the invocation cwd — otherwise running
  // `cortex decision candidates` from a subdirectory misses docs/ ADRs.
  try {
    const manifest = frameCandidates({ repo_path: ctx.gitRoot ?? ctx.cwd, max_candidates: max, base });
    // Always JSON — this is a machine manifest, not a human row list.
    process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("invalid base ref")) {
      throw new UsageError(e.message, "Example: cortex decision candidates --base=main");
    }
    throw e;
  }
}

function cmdCount(_cmd: DecisionCommand, ctx: ProjectContext): void {
  // Cold-start probe for hooks/scripts. Print 0 (not an error) when the repo
  // has no decisions yet, so the caller can branch on a clean integer.
  if (ctx.state === "no-project") {
    process.stdout.write("0\n");
    return;
  }
  const { db, svc } = openService(ctx);
  try {
    process.stdout.write(`${svc.list().length}\n`);
  } finally {
    db.close();
  }
}

export async function runDecisionCommand(cmd: DecisionCommand, ctx: ProjectContext): Promise<void> {
  switch (cmd.command) {
    case "candidates": return cmdCandidates(cmd, ctx);
    case "count":     return cmdCount(cmd, ctx);
    case "list":      return cmdList(cmd, ctx);
    case "show":      return cmdShow(cmd, ctx);
    case "why":       return cmdWhy(cmd, ctx);
    case "create":    return cmdCreate(cmd, ctx);
    case "update":    return cmdUpdate(cmd, ctx);
    case "delete":    return cmdDelete(cmd, ctx);
    case "link":      return cmdLink(cmd, ctx);
    case "promote":
      // TODO: wire to DecisionsRepository.updateTier once the tier model is
      // specced (personal → team semantics: who can promote, where a `team`
      // decision physically lives, how it's surfaced). See HANDOFF_DECISIONS.md
      // for the gap. Hidden from `cortex decision --help` until then.
      throw new UsageError(
        "promote is deferred until the tier model is specced",
        "See HANDOFF_DECISIONS.md (Gap 1). For MCP sessions, use the promote_decision tool.",
      );
    case "propose":   return cmdPropose(cmd, ctx);
    case "rehome":    return cmdRehome(cmd, ctx);
    case "supersede": return cmdSupersede(cmd, ctx);
    default:
      throw new UsageError(
        `unknown command 'cortex decision ${cmd.command}'`,
        "Run: cortex decision --help",
      );
  }
}

function cmdList(cmd: DecisionCommand, ctx: ProjectContext): void {
  const query = typeof cmd.flags.query === "string" ? cmd.flags.query : "";
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);

  if (cmd.flags["cross-repo"]) {
    const rows = crossRepoRows(ctx, query);
    writeRows(
      rows,
      fmt,
      query
        ? `no decisions matched '${query}' in any registered repo`
        : `no decisions in any registered repo`,
    );
    return;
  }

  const { db, svc } = openService(ctx);
  try {
    const results = query ? svc.search(query) : svc.list();
    const rows = results.map((d) => ({ id: d.id, title: d.title, status: d.status }));
    writeRows(
      rows,
      fmt,
      query
        ? `no decisions matched '${query}'`
        : `no decisions yet — try \`cortex decision create --title=...\``,
    );
  } finally {
    db.close();
  }
}

/**
 * CLI half of P5 cross-repo decision search (contract per decision D-hajs):
 * fan out over the master registry, flat rows with a `repo` column,
 * addressed repo first, unreachable rows noted on stderr — stdout stays
 * parseable. Lighter than the MCP fan-out on purpose: only each repo's
 * decisions sidecar is opened (no graph DB, no indexed-repo requirement).
 */
function crossRepoRows(
  ctx: ProjectContext,
  query: string,
): Array<{ repo: string; id: string; title: string; status: string }> {
  if (ctx.state === "no-project") {
    throw new EnvironmentError(
      "decisions require a git repository — cd into a repo first",
      "cortex tour    to see what's available without a project",
    );
  }
  const rows: Array<{ repo: string; id: string; title: string; status: string }> = [];
  const skipped: Array<{ repo: string; path: string; reason: string }> = [];
  // Dedupe on the RESOLVED sidecar path: worktrees/clones of one repo share a
  // durable store, and a CORTEX_DECISIONS_DB override collapses every repo to
  // one file — either way the same DB must not be read (and re-listed) twice.
  const seenDbPaths = new Set<string>();

  const homeRoot = ctx.gitRoot ?? ctx.cwd;
  const collect = (repoName: string, root: string) => {
    const dbPath = resolveDecisionsDbPath(root);
    if (seenDbPaths.has(dbPath)) return;
    seenDbPaths.add(dbPath);
    if (!existsSync(dbPath)) return; // no sidecar yet — zero decisions, not an error
    const db = openDecisionsDb(dbPath, legacyDecisionsDbPath(root));
    try {
      const repo = new DecisionsRepository(db);
      for (const d of query ? repo.search(query) : repo.list()) {
        rows.push({ repo: repoName, id: d.id, title: d.title, status: d.status });
      }
    } finally {
      db.close();
    }
  };

  collect(basename(homeRoot), homeRoot);

  let registry: Registry | null = null;
  try {
    registry = new Registry();
    for (const r of registry.list()) {
      try {
        if (!existsSync(r.root_path)) {
          skipped.push({ repo: r.name, path: r.root_path, reason: "path missing" });
          continue;
        }
        collect(r.name, r.root_path);
      } catch (e) {
        skipped.push({
          repo: r.name,
          path: r.root_path,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch {
    process.stderr.write("cortex: cross-repo: registry unavailable — searched the current repo only\n");
  } finally {
    registry?.close();
  }

  for (const s of skipped) {
    process.stderr.write(`cortex: cross-repo: skipped ${s.repo} (${s.path}): ${s.reason}\n`);
  }
  return rows;
}

function cmdShow(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex decision show <id>");
  const { db, svc } = openService(ctx);
  try {
    const d = svc.get(id);
    if (!d) throw new DomainError(`no decision with id '${id}'`, "Try: cortex decision list");
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function cmdWhy(cmd: DecisionCommand, ctx: ProjectContext): void {
  const input = cmd.positionals[0];
  if (!input) {
    throw new UsageError(
      "missing <input>",
      "Usage: cortex decision why <qualified-name-or-file-path>",
    );
  }
  const { db } = openService(ctx);
  try {
    const search = new DecisionSearch(
      new DecisionsRepository(db),
      new DecisionLinksRepository(db),
    );
    const hits = search.findGoverning(input);
    if (hits.length === 0) {
      throw new DomainError(
        `no decisions govern '${input}'`,
        "Try: cortex decision list",
      );
    }
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function cmdCreate(cmd: DecisionCommand, ctx: ProjectContext): void {
  const title = requireFlag("title", cmd.flags);
  const description = requireFlag("description", cmd.flags);
  const rationale = requireFlag("rationale", cmd.flags);
  const { db, svc } = openService(ctx);
  try {
    const d = svc.create({ title, description, rationale });
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function cmdUpdate(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) {
    throw new UsageError("missing <id>", "Usage: cortex decision update <id> --field=value ...");
  }
  const { db, svc, origin } = openService(ctx);
  try {
    const patch: Record<string, unknown> = { origin };
    for (const k of ["title", "description", "rationale", "problem", "resolution"]) {
      if (typeof cmd.flags[k] === "string") patch[k] = cmd.flags[k];
    }
    const d = svc.update(id, patch);
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function cmdDelete(cmd: DecisionCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex decision delete <id>");
  const { db, svc } = openService(ctx);
  try {
    svc.delete(id);
    process.stdout.write(`deleted ${id}\n`);
  } finally {
    db.close();
  }
}

function cmdLink(cmd: DecisionCommand, ctx: ProjectContext): void {
  const [id, target] = cmd.positionals;
  if (!id || !target) {
    throw new UsageError(
      "missing args",
      "Usage: cortex decision link <id> <target> [--relation=GOVERNS]",
    );
  }
  const relation = (cmd.flags.relation as string) ?? "GOVERNS";
  const { db, svc, origin } = openService(ctx);
  try {
    if (relation === "GOVERNS") svc.linkGoverns(id, target, origin);
    else if (relation === "REFERENCES") svc.linkReference(id, target, origin);
    else throw new UsageError(`unknown --relation '${relation}'`, "Allowed: GOVERNS, REFERENCES");
    process.stdout.write(`linked ${id} -[${relation}]-> ${target}\n`);
  } finally {
    db.close();
  }
}

function cmdPropose(cmd: DecisionCommand, ctx: ProjectContext): void {
  const title = requireFlag("title", cmd.flags);
  const problem = requireFlag("problem", cmd.flags);
  const resolution = requireFlag("resolution", cmd.flags);
  const rationale = requireFlag("rationale", cmd.flags);
  const { db, svc } = openService(ctx);
  try {
    const d = svc.propose({ title, problem, resolution, rationale });
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally {
    db.close();
  }
}

function cmdSupersede(cmd: DecisionCommand, ctx: ProjectContext): void {
  const oldId = cmd.positionals[0];
  if (!oldId) {
    throw new UsageError(
      "missing <old-id>",
      "Usage: cortex decision supersede <old-id> --title=... --problem=... --resolution=... --rationale=...",
    );
  }
  const title = requireFlag("title", cmd.flags);
  const problem = requireFlag("problem", cmd.flags);
  const resolution = requireFlag("resolution", cmd.flags);
  const rationale = requireFlag("rationale", cmd.flags);
  const { db, svc, origin } = openService(ctx);
  try {
    const d = svc.supersede({ old_decision_id: oldId, title, problem, resolution, rationale, origin });
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally {
    db.close();
  }
}
