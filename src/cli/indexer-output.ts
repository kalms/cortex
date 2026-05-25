/**
 * The indexer's `cli` subcommand returns MCP tool responses on stdout:
 *
 *   {"content":[{"type":"text","text":"<JSON-or-text payload>"}],
 *    "isError"?: true}
 *
 * It also writes free-form logging on the same stream:
 *   level=info msg=mem.init ...
 *
 * Without unwrapping, every code/show, code/search, code/arch, graph/query,
 * index/status, and index/list call dumps the wall-of-escaped-JSON envelope
 * straight to the user's terminal. This helper turns that into something
 * readable and surfaces error payloads as DomainError so the CLI returns
 * a useful exit code instead of always-0.
 */
import { DomainError } from "./errors.js";

export type IndexerResult = {
  text: string;
  isError: boolean;
  parsed: unknown;
};

const LOG_LINE = /^level=(info|warn|error|debug)\b/;

function lastJsonObjectLine(raw: string): string | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || LOG_LINE.test(line)) continue;
    if (line.startsWith("{") || line.startsWith("[")) return line;
  }
  return null;
}

export function unwrapIndexerResult(raw: string): IndexerResult {
  const jsonLine = lastJsonObjectLine(raw);
  if (!jsonLine) {
    return { text: raw.trim(), isError: false, parsed: null };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(jsonLine);
  } catch {
    return { text: jsonLine, isError: false, parsed: null };
  }
  // Standard MCP envelope.
  if (
    envelope &&
    typeof envelope === "object" &&
    "content" in envelope &&
    Array.isArray((envelope as { content: unknown[] }).content)
  ) {
    const env = envelope as { content: Array<{ text?: string }>; isError?: boolean };
    const text = env.content.map((c) => c.text ?? "").join("");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { text, isError: env.isError === true, parsed };
  }
  // Not an MCP envelope — return the raw JSON.
  return { text: jsonLine, isError: false, parsed: envelope };
}

/**
 * Pretty-print an unwrapped result for the user. If the inner text is JSON,
 * re-indent it; if it is an error payload, throw a DomainError. Returns the
 * text the caller should write to stdout.
 */
export function renderIndexerResult(result: IndexerResult): string {
  if (result.isError) {
    const parsed = result.parsed as { error?: string; hint?: string } | null;
    const msg = parsed?.error ?? result.text;
    const hint = parsed?.hint;
    throw new DomainError(String(msg), hint);
  }
  if (result.parsed && typeof result.parsed === "object") {
    return JSON.stringify(result.parsed, null, 2);
  }
  return result.text;
}
