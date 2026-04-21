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
  | "fs_error";

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function empty(query: string) {
  return { content: [{ type: "text" as const, text: `No results: ${query}` }] };
}

export function error(reason: ErrorReason, detail: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `ERROR reason=${reason}: ${detail}` }],
  };
}
