import { z } from "zod";

const TextContent = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const SuccessResponse = z.object({
  content: z.array(TextContent).min(1),
  isError: z.undefined().optional(),
});

export const NoResultsResponse = z.object({
  content: z.array(TextContent).length(1).refine(
    (arr) => arr[0].text.startsWith("No results: "),
    { message: "NoResultsResponse content must start with 'No results: '" }
  ),
  isError: z.undefined().optional(),
});

export const ErrorResponse = z.object({
  content: z.array(TextContent).length(1).refine(
    (arr) => /^ERROR reason=[a-z_]+: /.test(arr[0].text),
    { message: "ErrorResponse content must start with 'ERROR reason=<slug>: '" }
  ),
  isError: z.literal(true),
});

export const ResponseSchema = z.union([ErrorResponse, NoResultsResponse, SuccessResponse]);

export type ErrorReason =
  | "project_not_found"
  | "binary_failed"
  | "malformed_input"
  | "internal_error"
  | "fs_error"
  | "ambiguous_input"
  | "not_reconcilable"
  | "invalid_pattern"
  | "indexer_unavailable";

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * A "nothing matched" result. `hint` is optional routing prose appended below
 * the stable `No results: <query>` line — use it where an empty result is
 * plausibly a *retrieval* miss the caller can fix by reaching for a different
 * tool, not a statement that the thing does not exist. The prefix contract
 * (and so `NoResultsResponse`) is unaffected either way.
 */
export function empty(query: string, hint?: string) {
  const text = hint ? `No results: ${query}\n\n${hint}` : `No results: ${query}`;
  return { content: [{ type: "text" as const, text }] };
}

export function error(reason: ErrorReason, detail: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `ERROR reason=${reason}: ${detail}` }],
  };
}
