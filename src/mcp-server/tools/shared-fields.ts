import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema fields shared across the tool modules.
//
// `repo_path` is marked optional at the Zod layer so the SDK's input
// validation does not fire before `registerTool`'s pre-check has a chance
// to throw the friendly `MissingRepoPathError` (which carries the list of
// available projects so an agent can self-correct). The .describe() text
// makes the field's REQUIRED status explicit to LLM-facing tool listings.
// ---------------------------------------------------------------------------

export const RepoPathField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "REQUIRED. Absolute path to the indexed git root this call is about. " +
      "If you don't know it, call list_projects first.",
  );

export const AlternativeSchema = z.object({
  name: z.string(),
  reason_rejected: z.string(),
});

export const ProvenanceSchema = z.object({
  source: z.enum(["adr", "prose", "commits"]),
  doc_path: z.string().optional(),
  commit_shas: z.array(z.string()).optional(),
  confidence: z.enum(["high", "medium", "low"]),
});
