import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TodoService } from "../../todos/service.js";
import { TodosRepository } from "../../todos/repository.js";
import { TodoLinksRepository } from "../../todos/links-repository.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { validatePrimitiveFields } from "./decision-input-validation.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import type { EventBus } from "../../events/bus.js";
import { RepoPathField } from "./shared-fields.js";

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
} as const;

const todoSchema = z.object(todoShape);
type TodoArgs = z.infer<typeof todoSchema>;

const todoServiceFor = (ctx: RepoContext, projectId: string | null, bus?: EventBus): TodoService =>
  new TodoService({
    db: ctx.decisionsDb,
    todos: new TodosRepository(ctx.decisionsDb),
    links: new TodoLinksRepository(ctx.decisionsDb),
    bus,
    project_id: projectId ?? "",
  });

function need<T>(v: T | undefined, action: string, field: string): T {
  if (v === undefined) throw new Error(`todo(${action}) requires '${field}'`);
  return v;
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
          case "propose":
            return ok(
              JSON.stringify(
                svc.propose({
                  summary: need(args.summary, "propose", "summary"),
                  description: args.description,
                  proposed_by: args.proposed_by,
                  governs: args.governs,
                  spawns_from: args.spawns_from,
                  blocked_by: args.blocked_by,
                }),
                null,
                2,
              ),
            );
          case "get": {
            const t = svc.getWithRefs(need(args.id, "get", "id"));
            return t ? ok(JSON.stringify(t, null, 2)) : empty(`todo(get ${args.id})`);
          }
          case "list":
            return ok(JSON.stringify(svc.list(), null, 2));
          case "search": {
            const r = svc.search(need(args.query, "search", "query"));
            return r.length ? ok(JSON.stringify(r, null, 2)) : empty(`todo(search ${args.query})`);
          }
          case "update":
            return ok(
              JSON.stringify(
                svc.update(need(args.id, "update", "id"), {
                  summary: args.summary,
                  description: args.description,
                  assignee: args.assignee,
                  governs: args.governs,
                }),
                null,
                2,
              ),
            );
          case "link":
            svc.link({
              todo_id: need(args.id, "link", "id"),
              target: need(args.target, "link", "target"),
              relation: need(args.relation, "link", "relation"),
            });
            return ok(
              JSON.stringify({ linked: true, todo_id: args.id, target: args.target, relation: args.relation }),
            );
          case "transition":
            return ok(
              JSON.stringify(
                svc.transition(need(args.id, "transition", "id"), {
                  to: need(args.to, "transition", "to"),
                  reason: args.reason,
                  resolved_by: args.resolved_by,
                  blocked_by: args.blocked_by,
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
