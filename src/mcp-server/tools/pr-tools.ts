import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PRService } from "../../prs/service.js";
import { ok, empty, error as errorResponse } from "../response.js";

export function registerPRTools(server: McpServer, prs: PRService): void {
  server.tool(
    "open_pr",
    "Create a pull request entity in the graph.",
    {
      title: z.string(),
      author: z.string(),
      description: z.string().optional(),
      branch: z.string().optional(),
      state: z.enum(["draft", "open", "merged", "closed"]).optional(),
      introduces_frame: z.string().optional(),
      additions: z.number().int().optional(),
      source: z.enum(["native", "mirror", "scenario"]).optional(),
      external_ref: z
        .object({
          provider: z.string(),
          repo: z.string(),
          number: z.number().int(),
          url: z.string(),
        })
        .optional(),
    },
    async (params) => {
      try {
        const pr = prs.open(params);
        return ok(JSON.stringify(pr, null, 2));
      } catch (e) {
        return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "add_pr_touch",
    "Record that a PR touches (adds or modifies) a file.",
    {
      pr_number: z.number().int(),
      frame_id: z.string(),
      node_name: z.string(),
      action: z.enum(["added", "modified"]),
    },
    async (params) => {
      try {
        prs.addTouch(params);
        return ok(JSON.stringify({ ok: true, ...params }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`add_pr_touch(#${params.pr_number})`);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "merge_pr",
    "Mark a PR merged. Ratifies any introduced decisions from proposed to active.",
    { pr_number: z.number().int() },
    async ({ pr_number }) => {
      try {
        const result = prs.merge(pr_number);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`merge_pr(#${pr_number})`);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "get_pr",
    "Fetch a PR with resolved decision refs and linked PRs.",
    { pr_number: z.number().int() },
    async ({ pr_number }) => {
      const pr = prs.getWithRefs(pr_number);
      if (!pr) return empty(`get_pr(#${pr_number})`);
      return ok(JSON.stringify(pr, null, 2));
    }
  );
}
