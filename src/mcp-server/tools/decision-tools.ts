import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionService } from "../../decisions/service.js";
import { DecisionSearch } from "../../decisions/search.js";
import { ok, empty, error as errorResponse } from "../response.js";

const AlternativeSchema = z.object({
  name: z.string(),
  reason_rejected: z.string(),
});

export function registerDecisionTools(
  server: McpServer,
  service: DecisionService,
  search: DecisionSearch
): void {
  server.tool(
    "create_decision",
    "Create a new decision node with rationale, alternatives, and links to governed code",
    {
      title: z.string().describe("Short name for the decision"),
      description: z.string().describe("What was decided"),
      rationale: z.string().describe("Why this decision was made"),
      alternatives: z.array(AlternativeSchema).optional().describe("Rejected alternatives with reasons"),
      governs: z.array(z.string()).optional().describe("Node IDs or file paths this decision governs"),
      references: z.array(z.string()).optional().describe("Node IDs of external reference nodes"),
      problem: z.string().optional().describe("Narrative: what question this decision answers"),
      resolution: z.string().optional().describe("Narrative: what was decided"),
    },
    async (params) => {
      try {
        const decision = service.create(params);
        return ok(JSON.stringify(decision, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "propose_decision",
    "Create a proposed decision (status='proposed'). Optionally link to a PR as 'introduces'.",
    {
      title: z.string(),
      problem: z.string(),
      resolution: z.string(),
      rationale: z.string(),
      alternatives: z.array(AlternativeSchema).optional(),
      governs: z.array(z.string()).optional(),
      references: z.array(z.string()).optional(),
      pr_number: z.number().int().optional(),
    },
    async (params) => {
      try {
        const d = service.propose(params);
        return ok(JSON.stringify(d, null, 2));
      } catch (e) {
        return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "supersede_decision",
    "Atomically create a new decision that supersedes an existing one.",
    {
      old_decision_id: z.string(),
      title: z.string(),
      problem: z.string(),
      resolution: z.string(),
      rationale: z.string(),
      alternatives: z.array(AlternativeSchema).optional(),
      governs: z.array(z.string()).optional(),
      references: z.array(z.string()).optional(),
    },
    async (params) => {
      try {
        const d = service.supersede(params);
        return ok(JSON.stringify(d, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`supersede_decision(${params.old_decision_id})`);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "update_decision",
    "Update an existing decision's fields",
    {
      id: z.string().describe("Decision node ID"),
      title: z.string().optional(),
      description: z.string().optional(),
      rationale: z.string().optional(),
      alternatives: z.array(AlternativeSchema).optional(),
      status: z.enum(["active", "superseded", "deprecated"]).optional(),
      superseded_by: z.string().optional().describe("ID of the superseding decision"),
      problem: z.string().nullable().optional().describe("Narrative: what question this decision answers"),
      resolution: z.string().nullable().optional().describe("Narrative: what was decided"),
    },
    async ({ id, ...updates }) => {
      try {
        const decision = service.update(id, updates);
        return ok(JSON.stringify(decision, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`update_decision(${id})`);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "delete_decision",
    "Delete a decision and all its edges",
    {
      id: z.string().describe("Decision node ID"),
    },
    async ({ id }) => {
      try {
        service.delete(id);
        return ok(JSON.stringify({ deleted: id }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`delete_decision(${id})`);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "get_decision",
    "Get a decision with all resolved relationships: governs (code nodes), references (external nodes), related_decisions, depends_on, and PR back-refs (introduced_in, implemented_by, challenged_by, discussed_in)",
    {
      id: z.string().describe("Decision node ID"),
    },
    async ({ id }) => {
      const d = service.getWithRefs(id);
      if (!d) return empty(`get_decision(${id})`);
      return ok(JSON.stringify(d, null, 2));
    }
  );

  server.tool(
    "search_decisions",
    "Full-text search over decision titles, descriptions, and rationale",
    {
      query: z.string().describe("Search query (FTS5 syntax)"),
      scope: z.string().optional().describe("Qualified name or file path to scope results"),
    },
    async ({ query, scope }) => {
      try {
        const results = search.search(query, scope);
        if (results.length === 0) return empty(`search_decisions(${query})`);
        return ok(JSON.stringify(results, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "why_was_this_built",
    "Find decisions governing a code entity — walks up file/directory hierarchy if no direct match",
    {
      qualified_name: z.string().describe("Qualified name or file path of the code entity"),
    },
    async ({ qualified_name }) => {
      try {
        const results = search.whyWasThisBuilt(qualified_name);
        if (!results || (Array.isArray(results) && results.length === 0)) {
          return empty(`why_was_this_built(${qualified_name})`);
        }
        return ok(JSON.stringify(results, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "link_decision",
    "Attach additional GOVERNS or REFERENCES edges to an existing decision",
    {
      decision_id: z.string().describe("Decision node ID"),
      target: z.string().describe("Target node ID or file path"),
      relation: z.enum(["GOVERNS", "REFERENCES", "RELATED_TO", "DEPENDS_ON"])
        .optional()
        .describe("Edge type (default: GOVERNS)"),
    },
    async ({ decision_id, target, relation }) => {
      try {
        const rel = relation ?? "GOVERNS";
        if (rel === "GOVERNS") service.linkGoverns(decision_id, target);
        else if (rel === "REFERENCES") service.linkReference(decision_id, target);
        else if (rel === "RELATED_TO") service.linkRelatedTo(decision_id, target);
        else if (rel === "DEPENDS_ON") service.linkDependsOn(decision_id, target);
        return ok(JSON.stringify({ linked: true, decision_id, target, relation: rel }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`link_decision(${decision_id})`);
        return errorResponse("internal_error", msg);
      }
    }
  );
}
