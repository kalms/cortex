import { randomInt } from "node:crypto";

/** Entity types that receive the full short-id + seq treatment. */
export type EntityType = "decision" | "todo" | "story";

/** Single-letter display/canonical prefix per entity type. */
export const PREFIX: Record<EntityType, string> = {
  decision: "D",
  todo: "T",
  story: "S",
};

/**
 * Crockford base32, lowercase, minus the visually ambiguous i l o u.
 * 32 symbols -> 4 chars give 32^4 ≈ 1.05M values per type per repo.
 */
export const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TOKEN_LEN = 4;
const TOKEN_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{4}$/;
const HAS_LETTER_RE = /[a-z]/;

/** Default token source: TOKEN_LEN symbols drawn from ALPHABET via crypto. */
function cryptoToken(): string {
  let out = "";
  for (let i = 0; i < TOKEN_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Produce a token that always contains at least one letter, so the canonical
 * namespace is disjoint from the all-digit seq namespace. `draw` is injectable
 * for deterministic tests; it must return TOKEN_LEN symbols from ALPHABET.
 */
export function randomToken(draw: () => string = cryptoToken): string {
  for (let i = 0; i < 1000; i++) {
    const tok = draw();
    if (TOKEN_RE.test(tok) && HAS_LETTER_RE.test(tok)) return tok;
  }
  throw new Error("randomToken: exhausted attempts producing a valid token");
}

export function formatCanonical(type: EntityType, token: string): string {
  return `${PREFIX[type]}-${token}`;
}

export function formatDisplay(type: EntityType, seq: number): string {
  return `${PREFIX[type]}-${seq}`;
}

export type ParsedRef =
  | { kind: "seq"; seq: number }
  | { kind: "canonical"; id: string };

/**
 * Resolve a raw reference (with or without the type prefix) into either a seq
 * lookup or a canonical id. Returns null on prefix mismatch or empty body.
 * Rule: an all-digit body is a seq; anything else is a canonical token.
 */
export function parseRef(type: EntityType, raw: string): ParsedRef | null {
  if (!raw) return null;
  const prefix = `${PREFIX[type]}-`;
  let body = raw;
  if (raw.includes("-")) {
    if (!raw.startsWith(prefix)) return null;
    body = raw.slice(prefix.length);
  }
  if (!body) return null;
  if (/^\d+$/.test(body)) return { kind: "seq", seq: Number(body) };
  return { kind: "canonical", id: formatCanonical(type, body) };
}
