import { join } from "node:path";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { DecisionService } from "../../decisions/service.js";
import { DecisionSearch } from "../../decisions/search.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError } from "../errors.js";
import { writeRows, chooseFormat } from "../format.js";

export type DecisionCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function openService(ctx: ProjectContext) {
  // Decisions db sits next to the graph db. If no indexed project, fall back
  // to a cwd-local file at .cortex/decisions.db.
  const dbPath = join(ctx.cwd, ".cortex", "decisions.db");
  const db = openDecisionsDb(dbPath);
  const links = new DecisionLinksRepository(db);
  const svc = new DecisionService({
    decisions: new DecisionsRepository(db),
    links,
  });
  return { db, svc, links };
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

export async function runDecisionCommand(cmd: DecisionCommand, ctx: ProjectContext): Promise<void> {
  switch (cmd.command) {
    case "list":      return cmdList(cmd, ctx);
    case "show":      return cmdShow(cmd, ctx);
    case "why":       return cmdWhy(cmd, ctx);
    case "create":    return cmdCreate(cmd, ctx);
    case "update":    return cmdUpdate(cmd, ctx);
    case "delete":    return cmdDelete(cmd, ctx);
    case "link":      return cmdLink(cmd, ctx);
    case "promote":
      throw new UsageError(
        "promote not yet wired up",
        "Use bin/cortex-indexer cli promote_decision for now",
      );
    case "propose":   return cmdPropose(cmd, ctx);
    case "supersede": return cmdSupersede(cmd, ctx);
    default:
      throw new UsageError(
        `unknown command 'cortex decision ${cmd.command}'`,
        "Run: cortex decision --help",
      );
  }
}

function cmdList(cmd: DecisionCommand, ctx: ProjectContext): void {
  const { db, svc } = openService(ctx);
  try {
    const query = typeof cmd.flags.query === "string" ? cmd.flags.query : "";
    const results = query ? svc.search(query) : svc.list();
    const rows = results.map((d) => ({ id: d.id, title: d.title, status: d.status }));
    const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
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
      process.stderr.write(`no decisions govern '${input}'\n`);
      return;
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
  const { db, svc } = openService(ctx);
  try {
    const patch: Record<string, unknown> = {};
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
  const { db, svc } = openService(ctx);
  try {
    if (relation === "GOVERNS") svc.linkGoverns(id, target);
    else if (relation === "REFERENCES") svc.linkReference(id, target);
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
  const { db, svc } = openService(ctx);
  try {
    const d = svc.supersede({ old_decision_id: oldId, title, problem, resolution, rationale });
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  } finally {
    db.close();
  }
}
