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
 * unknown `type` values, or invalid payload shapes.
 *
 * Payload validation is intentionally inline (no schema lib) — the three
 * message types are stable and simple enough. The throw path here produces the
 * `bad_message` error reply in server.ts; the connection stays open.
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
  const m = obj as Record<string, unknown>;
  const type = m.type;
  if (type === 'ping') return obj as ClientMsg;
  if (type === 'catchup') {
    if (typeof m.since !== 'string' || m.since.length === 0) {
      throw new Error('catchup.since must be a non-empty string');
    }
    return obj as ClientMsg;
  }
  if (type === 'backfill') {
    if (m.before_id !== undefined && typeof m.before_id !== 'string') {
      throw new Error('backfill.before_id must be a string if present');
    }
    if (m.limit !== undefined && (typeof m.limit !== 'number' || !isFinite(m.limit))) {
      throw new Error('backfill.limit must be a finite number if present');
    }
    return obj as ClientMsg;
  }
  throw new Error(`unknown client message type: ${String(type)}`);
}
