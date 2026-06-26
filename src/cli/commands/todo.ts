import { openDecisionsDb } from "../../decisions/db.js";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
import { TodoService } from "../../todos/service.js";
import { TodosRepository } from "../../todos/repository.js";
import { TodoLinksRepository } from "../../todos/links-repository.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import { writeRows, chooseFormat } from "../format.js";
import { openEditor } from "../editor.js";

export type TodoCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function openService(ctx: ProjectContext) {
  if (ctx.state === "no-project") {
    throw new EnvironmentError(
      "todos require a git repository — cd into a repo first",
      "cortex tour    to see what's available without a project",
    );
  }
  const root = ctx.gitRoot ?? ctx.cwd;
  const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
  const svc = new TodoService({
    db,
    todos: new TodosRepository(db),
    links: new TodoLinksRepository(db),
  });
  return { db, svc };
}

function requireFlag(name: string, flags: Record<string, unknown>, usage: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) throw new UsageError(`missing --${name}`, usage);
  return v;
}

function parseList(v: unknown): string[] | undefined {
  return typeof v === "string"
    ? v.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
}

/** Parse an editor buffer into summary + description. Comment lines (first
 *  non-space char '#') are dropped; the first remaining non-blank line is the
 *  summary; everything after it (trimmed) is the description. */
export function parseTodoTemplate(text: string): { summary: string; description: string | undefined } {
  const lines = text.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  while (lines.length && lines[0].trim() === "") lines.shift();
  const summary = (lines.shift() ?? "").trim();
  const description = lines.join("\n").trim();
  return { summary, description: description.length ? description : undefined };
}

export async function runTodoCommand(cmd: TodoCommand, ctx: ProjectContext): Promise<void> {
  switch (cmd.command) {
    case "list":       return cmdList(cmd, ctx);
    case "show":       return cmdShow(cmd, ctx);
    case "search":     return cmdSearch(cmd, ctx);
    case "propose":    return cmdPropose(cmd, ctx);
    case "update":     return cmdUpdate(cmd, ctx);
    case "transition": return cmdTransition(cmd, ctx);
    case "link":       return cmdLink(cmd, ctx);
    default:
      throw new UsageError(`unknown command 'cortex todo ${cmd.command}'`, "Run: cortex todo --help");
  }
}

function cmdList(cmd: TodoCommand, ctx: ProjectContext): void {
  const { db, svc } = openService(ctx);
  try {
    const query = typeof cmd.flags.query === "string" ? cmd.flags.query : "";
    const results = query ? svc.search(query) : svc.list();
    const rows = results.map((t) => ({ id: t.id, summary: t.summary, state: t.state }));
    const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY ?? false);
    writeRows(rows, fmt, query ? `no todos matched '${query}'` : "no todos yet — try `cortex todo propose`");
  } finally { db.close(); }
}

function cmdShow(cmd: TodoCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex todo show <id>");
  const { db, svc } = openService(ctx);
  try {
    const t = svc.getWithRefs(id);
    if (!t) throw new DomainError(`no todo with id '${id}'`, "Try: cortex todo list");
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdSearch(cmd: TodoCommand, ctx: ProjectContext): void {
  const query = cmd.positionals[0];
  if (!query) throw new UsageError("missing <query>", "Usage: cortex todo search <query>");
  const { db, svc } = openService(ctx);
  try {
    const rows = svc.search(query).map((t) => ({ id: t.id, summary: t.summary, state: t.state }));
    const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY ?? false);
    writeRows(rows, fmt, `no todos matched '${query}'`);
  } finally { db.close(); }
}

// --- write commands: minimal flag-only forms; editor flow added in Task 4 ---

function cmdPropose(cmd: TodoCommand, ctx: ProjectContext): void {
  const summary = cmd.positionals[0] ?? (typeof cmd.flags.summary === "string" ? cmd.flags.summary : undefined);
  if (!summary) throw new UsageError("missing <summary>", "Usage: cortex todo propose <summary> [--description=...]");
  const { db, svc } = openService(ctx);
  try {
    const t = svc.propose({
      summary,
      description: typeof cmd.flags.description === "string" ? cmd.flags.description : undefined,
      proposed_by: typeof cmd.flags["proposed-by"] === "string" ? cmd.flags["proposed-by"] : undefined,
      governs: parseList(cmd.flags.governs),
      spawns_from: typeof cmd.flags["spawns-from"] === "string" ? cmd.flags["spawns-from"] : undefined,
      blocked_by: parseList(cmd.flags["blocked-by"]),
    });
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdUpdate(cmd: TodoCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex todo update <id> [--summary=...] [--description=...]");
  const { db, svc } = openService(ctx);
  try {
    const patch: { summary?: string; description?: string; assignee?: string | null; governs?: string[] } = {};
    if (typeof cmd.flags.summary === "string") patch.summary = cmd.flags.summary;
    if (typeof cmd.flags.description === "string") patch.description = cmd.flags.description;
    if (typeof cmd.flags.assignee === "string") patch.assignee = cmd.flags.assignee;
    const governs = parseList(cmd.flags.governs);
    if (governs) patch.governs = governs;
    const t = svc.update(id, patch);
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdTransition(cmd: TodoCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  const to = cmd.positionals[1];
  if (!id || !to) throw new UsageError("missing args", "Usage: cortex todo transition <id> <state> [--reason=...]");
  const { db, svc } = openService(ctx);
  try {
    const t = svc.transition(id, {
      to: to as "open" | "in_progress" | "blocked" | "done" | "cancelled",
      reason: typeof cmd.flags.reason === "string" ? cmd.flags.reason : undefined,
      resolved_by: parseList(cmd.flags["resolved-by"]),
      blocked_by: parseList(cmd.flags["blocked-by"]),
    });
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Invalid transition|not found/i.test(msg)) throw new DomainError(msg, "Try: cortex todo show " + id);
    throw e;
  } finally { db.close(); }
}

function cmdLink(cmd: TodoCommand, ctx: ProjectContext): void {
  const [id, target] = cmd.positionals;
  if (!id || !target) throw new UsageError("missing args", "Usage: cortex todo link <id> <target> [--relation=GOVERNS]");
  const relation = (typeof cmd.flags.relation === "string" ? cmd.flags.relation : "GOVERNS") as
    "GOVERNS" | "BLOCKED_BY" | "RELATED_TO" | "SPAWNS_FROM" | "RESOLVED_BY";
  const { db, svc } = openService(ctx);
  try {
    svc.link({ todo_id: id, target, relation });
    process.stdout.write(`linked ${id} -[${relation}]-> ${target}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) throw new DomainError(msg, "Try: cortex todo list");
    throw e;
  } finally { db.close(); }
}

// Re-export so Task 4 can wire the editor without touching the dispatch.
export { openEditor };
