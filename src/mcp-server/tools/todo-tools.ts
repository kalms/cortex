import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureOrigin } from "../../git/origin.js";
import { TodoService } from "../../todos/service.js";
import { TodosRepository } from "../../todos/repository.js";
import { TodoLinksRepository } from "../../todos/links-repository.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { validatePrimitiveFields } from "./decision-input-validation.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import type { EventBus } from "../../events/bus.js";
import { RepoPathField } from "./shared-fields.js";
import { hashGovernedSource, type GovernedRef } from "../../decisions/reconciliation.js";

const todoShape = {
  repo_path: RepoPathField,
  action: z.enum(["propose", "get", "list", "search", "update", "link", "transition"]),
  // propose
  summary: z.string().optional(),
  description: z.string().optional(),
  proposed_by: z.string().optional(),
  governs: z.array(z.string()).optional(),
  spawns_from: z.string().optional(),
  blocked_by: z.array(z.string()).optional(),
  // get / update / link / transition target
  id: z.string().optional(),
  // update
  assignee: z.string().nullable().optional(),
  // search
  query: z.string().optional(),
  // link
  target: z.string().optional(),
  relation: z.enum(["GOVERNS", "BLOCKED_BY", "RELATED_TO", "SPAWNS_FROM", "RESOLVED_BY"]).optional(),
  // transition
  to: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional(),
  reason: z.string().optional(),
  resolved_by: z.array(z.string()).optional(),
  // propose
  thread: z.string().optional().describe(
    "propose: caller-supplied thread/session id for origin provenance. " +
    "list/search: exact match filter on origin_thread (never matches a NULL-origin row)",
  ),
  // list / search
  branch: z.string().min(1).optional()
    .describe("list/search: exact match filter on origin_branch (never matches a NULL-origin row)"),
} as const;

const todoSchema = z.object(todoShape);
type TodoArgs = z.infer<typeof todoSchema>;

interface TodoServiceBundle {
  service: TodoService;
  todos: TodosRepository;
  links: TodoLinksRepository;
}

const todoServiceFor = (ctx: RepoContext, projectId: string | null, bus?: EventBus): TodoServiceBundle => {
  const todos = new TodosRepository(ctx.decisionsDb);
  const links = new TodoLinksRepository(ctx.decisionsDb);
  const service = new TodoService({ db: ctx.decisionsDb, todos, links, bus, project_id: projectId ?? "" });
  return { service, todos, links };
};

function need<T>(v: T | undefined, action: string, field: string): T {
  if (v === undefined) throw new Error(`todo(${action}) requires '${field}'`);
  return v;
}

/** GOVERNS-only refs for a todo, in the shape hashGovernedSource expects.
 *  Mirrors governedRefs() in reconciliation-attach.ts (the decision-side
 *  equivalent), but reads from the todo links table. */
function governedTodoRefs(links: TodoLinksRepository, todoId: string): GovernedRef[] {
  return links.findByTodo(todoId)
    .filter((l) => l.relation === "GOVERNS")
    .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
}

export const todoHandler = (resolver: RepoContextResolver, indexerProject: string | null = null, bus?: EventBus) =>
  registerTool(
    "todo",
    todoSchema,
    async (ctx: RepoContext, args: TodoArgs) => {
      const bad = validatePrimitiveFields(args as Record<string, unknown>, ["summary", "description", "reason"]);
      if (bad) {
        return errorResponse(
          "malformed_input",
          `Field '${bad.field}' contains marker '${bad.marker}'. Re-send it as a plain string.`,
        );
      }
      const svc = todoServiceFor(ctx, indexerProject, bus);
      try {
        switch (args.action) {
          case "propose": {
            const created = svc.service.propose({
              summary: need(args.summary, "propose", "summary"),
              description: args.description,
              proposed_by: args.proposed_by,
              governs: args.governs,
              spawns_from: args.spawns_from,
              blocked_by: args.blocked_by,
              // captureOrigin is called HERE, in the handler, on
              // ctx.repoPath (the checkout root) — never in the
              // service, which stays free of git dependencies.
              origin: captureOrigin(ctx.repoPath, args.thread ?? null),
            });
            // basis_hash must be computed AFTER the GOVERNS links written by
            // propose() above have landed, or governedTodoRefs returns []
            // and the todo gets the same meaningless digest as one that
            // governs nothing. ctx.repoPath is the CHECKOUT root (2.0.0
            // two-axis split) — never the canonical root. See
            // tests/decisions/basis-anchoring.test.ts.
            const refs = governedTodoRefs(svc.links, created.id);
            if (refs.length > 0) {
              svc.todos.update(created.id, { basis_hash: hashGovernedSource(ctx.repoPath, refs) });
            }
            return ok(JSON.stringify(created, null, 2));
          }
          case "get": {
            const t = svc.service.getWithRefs(need(args.id, "get", "id"));
            return t ? ok(JSON.stringify(t, null, 2)) : empty(`todo(get ${args.id})`);
          }
          case "list":
            // branch/thread push straight into the repository WHERE clause
            // (TodosRepository.list) — list has no FTS step to preserve, so
            // there's no post-filter needed the way search() requires below.
            return ok(JSON.stringify(svc.service.list({ branch: args.branch, thread: args.thread }), null, 2));
          case "search": {
            let r = svc.service.search(need(args.query, "search", "query"));
            if (args.branch !== undefined || args.thread !== undefined) {
              // search() maps through rowToTodo, which — like toDecision on
              // the decisions side — drops the origin_* columns. Look each
              // hit up in the raw repository to filter on them. NULL-safe by
              // construction: an unstamped row's origin_branch/origin_thread
              // is null/undefined, which never === a defined filter string.
              r = r.filter((t) => {
                const raw = svc.todos.get(t.id);
                return (args.branch === undefined || raw?.origin_branch === args.branch)
                  && (args.thread === undefined || raw?.origin_thread === args.thread);
              });
            }
            return r.length ? ok(JSON.stringify(r, null, 2)) : empty(`todo(search ${args.query})`);
          }
          case "update":
            return ok(
              JSON.stringify(
                svc.service.update(need(args.id, "update", "id"), {
                  summary: args.summary,
                  description: args.description,
                  assignee: args.assignee,
                  governs: args.governs,
                  // captureOrigin is called HERE, in the handler, on
                  // ctx.repoPath (the checkout root) — never in the
                  // service. Rewrites last_touched_* only.
                  origin: captureOrigin(ctx.repoPath),
                }),
                null,
                2,
              ),
            );
          case "link": {
            const origin = captureOrigin(ctx.repoPath);
            svc.service.link({
              todo_id: need(args.id, "link", "id"),
              target: need(args.target, "link", "target"),
              relation: need(args.relation, "link", "relation"),
            }, origin);
            return ok(
              JSON.stringify({ linked: true, todo_id: args.id, target: args.target, relation: args.relation }),
            );
          }
          case "transition":
            return ok(
              JSON.stringify(
                svc.service.transition(need(args.id, "transition", "id"), {
                  to: need(args.to, "transition", "to"),
                  reason: args.reason,
                  resolved_by: args.resolved_by,
                  blocked_by: args.blocked_by,
                  origin: captureOrigin(ctx.repoPath),
                }),
                null,
                2,
              ),
            );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`todo(${args.action} ${args.id ?? ""})`);
        if (/^Invalid transition|requires '/.test(msg)) return errorResponse("malformed_input", msg);
        return errorResponse("internal_error", msg);
      }
    },
    { resolver },
  );

export function registerTodoTools(
  server: McpServer,
  resolver: RepoContextResolver,
  indexerProject: string | null = null,
  bus?: EventBus,
): void {
  server.tool(
    "todo",
    "Manage TODO entities (future planned work). action: propose|get|list|search|update|link|transition. See docs/mcp-tools.md for per-action params.",
    todoShape,
    todoHandler(resolver, indexerProject, bus),
  );
}
