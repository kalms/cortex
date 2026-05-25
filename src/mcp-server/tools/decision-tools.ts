import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionService } from "../../decisions/service.js";
import { DecisionSearch } from "../../decisions/search.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { validateDecisionFields } from "./decision-input-validation.js";
import { resolveInput } from "../../shared/resolve-input.js";

const AlternativeSchema = z.object({
  name: z.string(),
  reason_rejected: z.string(),
});

export function registerDecisionTools(
  server: McpServer,
  service: DecisionService,
  search: DecisionSearch,
  links: DecisionLinksRepository,
  indexerProject?: string | null,
  dbPath?: string,
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
      const bad = validateDecisionFields(params as Record<string, unknown>);
      if (bad) {
        return errorResponse(
          "malformed_input",
          `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
        );
      }
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
      const bad = validateDecisionFields(params as Record<string, unknown>);
      if (bad) {
        return errorResponse(
          "malformed_input",
          `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
        );
      }
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
      const bad = validateDecisionFields(params as Record<string, unknown>);
      if (bad) {
        return errorResponse(
          "malformed_input",
          `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
        );
      }
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
    "Update an existing decision's fields (governs and references are full-set replacements when provided)",
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
      governs: z.array(z.string()).optional().describe("Full set replacement of GOVERNS targets. [] clears all."),
      references: z.array(z.string()).optional().describe("Full set replacement of REFERENCES targets. [] clears all."),
    },
    async (params) => {
      const bad = validateDecisionFields(params as Record<string, unknown>);
      if (bad) {
        return errorResponse(
          "malformed_input",
          `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
        );
      }
      const { id, ...updates } = params;
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
    "Get a decision with all resolved relationships: governs, references, related_decisions, depends_on, and PR back-refs (introduced_in, implemented_by, challenged_by, discussed_in)",
    {
      id: z.string().describe("Decision node ID"),
    },
    async ({ id }) => {
      const dec = service.get(id);
      if (!dec) return empty(`get_decision(${id})`);

      // Compose the "with refs" shape from the sidecar links table. The legacy
      // shape included full NodeRow objects for governs/references and full
      // Decision objects for related_decisions/depends_on; in the sidecar model
      // we only have target refs (qns/paths/decision-ids/pr-numbers), so we
      // surface those as `{ target_kind, target_ref }` and let the caller
      // resolve full node info via search_graph / get_decision as needed.
      const all = links.findByDecision(id);
      const pick = (relation: string) =>
        all
          .filter((l) => l.relation === relation)
          .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));

      // Decision-typed back-refs resolve to full Decision objects so callers
      // can read `.id`, `.title`, etc. directly (legacy contract).
      const pickDecisions = (relation: string) =>
        all
          .filter((l) => l.relation === relation && l.target_kind === "decision")
          .map((l) => service.get(l.target_ref))
          .filter((d): d is NonNullable<typeof d> => d !== null);

      // PR back-refs: in the sidecar model, PR <-> decision relations live on
      // decision_links where target_kind="pr" (target_ref = PR number as string).
      const prLinks = (relation: string) =>
        all
          .filter((l) => l.relation === relation && l.target_kind === "pr")
          .map((l) => ({ pr_number: Number(l.target_ref) }));

      const withRefs = {
        ...dec,
        governs: pick("GOVERNS"),
        references: pick("REFERENCES"),
        related_decisions: pickDecisions("DECISION_RELATED_TO"),
        depends_on: pickDecisions("DECISION_DEPENDS_ON"),
        introduced_in: prLinks("PR_INTRODUCES_DECISION")[0] ?? null,
        implemented_by: prLinks("PR_IMPLEMENTS_DECISION"),
        challenged_by: prLinks("PR_CHALLENGES_DECISION"),
        discussed_in: prLinks("PR_DISCUSSES_DECISION"),
      };
      return ok(JSON.stringify(withRefs, null, 2));
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
        let results = service.search(query);
        if (scope) {
          // Filter to decisions whose links table mentions `scope` as a governs
          // target (qn or path). This preserves the old MCP contract without
          // re-implementing the directory walk that DecisionSearch.findGoverning
          // does — `scope` here is a literal match filter.
          const governing = search.findGoverning(scope);
          const allowed = new Set(governing.map((d) => d.id));
          results = results.filter((d) => allowed.has(d.id));
        }
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
    "Find decisions governing a code entity. Input accepts qualified names, file paths, or bare symbol names. Walks up file/directory hierarchy if no direct match. Returns ambiguous_input with candidates if multiple symbols match.",
    {
      qualified_name: z.string().describe("Qualified name, file path, or bare symbol name of the code entity"),
    },
    async ({ qualified_name }) => {
      try {
        // Resolve bare names → concrete qn/path before calling findGoverning.
        // findGoverning already handles file paths and qns via its own walk;
        // the resolver fills the bare-name gap.
        //
        // Skip the resolver for inputs that already look like file paths (contain
        // '/' or end in a source extension) or qn separators ('::') — those are
        // passed directly to findGoverning for its own path/hierarchy walk.
        const SOURCE_EXT = /\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$/;
        const looksLikeFilePath = qualified_name.includes("/") || SOURCE_EXT.test(qualified_name);
        const looksLikeQn = qualified_name.includes("::");

        let target = qualified_name;
        if (indexerProject && dbPath && !looksLikeFilePath && !looksLikeQn) {
          const resolved = resolveInput(qualified_name, indexerProject, dbPath);
          if (resolved.kind === "multi") {
            const candidatesList = resolved.candidates
              .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
              .join("\n");
            return errorResponse(
              "ambiguous_input",
              `Multiple matches for '${qualified_name}'. Pick one and re-call:\n${candidatesList}`,
            );
          }
          if (resolved.kind === "single") {
            // Prefer file_path for path-walk semantics; fall back to qn.
            target = resolved.symbol.file_path || resolved.symbol.qn;
          }
          // 'none' falls through to findGoverning with the original input,
          // preserving back-compat for non-symbol inputs.
        }
        const results = search.findGoverning(target);
        if (!results || results.length === 0) {
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
