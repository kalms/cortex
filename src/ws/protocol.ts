import type { ServerMsg, ClientMsg } from './types.js';

/**
 * Encodes a server message for wire send.
 * Kept trivial (just JSON.stringify) — the boundary exists so we can swap in
 * MessagePack or compression later without touching call sites.
 */
export function encodeServer(msg: ServerMsg): string {
  return JSON.stringify(msg);
}

/**
 * Decodes a raw client message. Throws on malformed JSON, non-object payloads,
 * or unknown `type` values.
 *
 * Validation is minimal — we trust the type discriminator and leave payload
 * shape-checking to the handler (which would otherwise need a schema lib).
 */
export function decodeClient(raw: string): ClientMsg {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('malformed JSON');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('not a JSON object');
  }
  const type = (obj as { type?: unknown }).type;
  if (type === 'ping' || type === 'backfill') return obj as ClientMsg;
  throw new Error(`unknown client message type: ${String(type)}`);
}
