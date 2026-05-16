// scripts/frame-extraction/indexer.ts
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IndexerEnvelope } from "./types.js";

const INDEXER_BIN = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..", "..", "bin", "cortex-indexer",
);

interface McpEnvelope {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface InnerErrorPayload {
  status?: string;
  error_phase?: string;
  error?: string;
}

export function parseEnvelope<T>(raw: string): IndexerEnvelope<T> {
  let outer: McpEnvelope;
  try {
    outer = JSON.parse(raw);
  } catch {
    return { ok: false, status: "envelope_parse", error_phase: "envelope_parse", error: `outer JSON parse failed: ${raw.slice(0, 200)}`, raw };
  }
  const text = outer.content?.[0]?.text;
  if (typeof text !== "string") {
    return { ok: false, status: "envelope_parse", error_phase: "envelope_parse", error: "no content[0].text in envelope", raw };
  }
  let inner: unknown;
  try {
    inner = JSON.parse(text);
  } catch {
    return { ok: false, status: "envelope_parse", error_phase: "envelope_parse", error: `inner JSON parse failed: ${text.slice(0, 200)}`, raw };
  }
  if (outer.isError === true) {
    const e = inner as InnerErrorPayload;
    return {
      ok: false,
      status: e.status ?? "error",
      error_phase: e.error_phase ?? "unknown",
      error: e.error ?? text,
      raw,
    };
  }
  return { ok: true, data: inner as T };
}

/** Invoke `bin/cortex-indexer cli <tool> <json>` and parse the result. */
export function callIndexer<T>(tool: string, args: Record<string, unknown>): IndexerEnvelope<T> {
  const res = spawnSync(INDEXER_BIN, ["cli", tool, JSON.stringify(args)], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    return { ok: false, status: "spawn_error", error_phase: "spawn", error: String(res.error), raw: "" };
  }
  // The indexer prints log lines to stderr and the JSON envelope to stdout.
  // The MCP envelope is the LAST non-empty line of stdout.
  const lines = (res.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return parseEnvelope<T>(last);
}
