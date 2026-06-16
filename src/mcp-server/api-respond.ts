/**
 * The single JSON-response chokepoint for the HTTP contract.
 *
 * Responsibilities (so no handler can forget them):
 *  - validate the outgoing payload against its Zod schema, per the spec §3
 *    posture: THROW in test/CI (or under CORTEX_API_STRICT=1), else log + send;
 *  - honor `If-None-Match` → 304 Not Modified (empty body);
 *  - stamp `X-Cortex-API-Version`, `X-Cortex-Freshness`, and `ETag`;
 *  - send no body for HEAD (headers only), serialize JSON otherwise.
 *
 * `respondError` is the small sibling for 4xx/5xx (no schema validation).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ZodTypeAny } from "zod";
import type { Freshness } from "./freshness.js";
import { CONTRACT_VERSION } from "./api-schemas.js";

/** True when a response-schema mismatch must throw rather than log+send. */
export function isStrict(): boolean {
  return (
    process.env.CORTEX_API_STRICT === "1" ||
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test"
  );
}

export interface RespondCtx {
  req: IncomingMessage;
  freshness: Freshness;
  etag: string;
  /** Override the strict decision (tests). Defaults to `isStrict()`. */
  strict?: boolean;
  /** Extra headers (e.g. CORS) to merge in. */
  headers?: Record<string, string>;
}

/**
 * The single JSON-response chokepoint: validate `data` against `schema` (per the
 * strict posture), honor `If-None-Match` → `304`, stamp the version/freshness/
 * ETag headers, and serialize (no body for `HEAD`). Every data handler routes
 * through this so those cross-cutting concerns can't be forgotten on a new route.
 */
export function respond<T>(
  res: ServerResponse,
  schema: ZodTypeAny,
  data: T,
  ctx: RespondCtx,
): void {
  const strict = ctx.strict ?? isStrict();
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    if (strict) {
      throw new Error(`API response schema mismatch: ${parsed.error.message}`);
    }
    console.error(`[cortex api] response schema mismatch (sent anyway): ${parsed.error.message}`);
  }

  const baseHeaders: Record<string, string> = {
    "X-Cortex-API-Version": String(CONTRACT_VERSION),
    "X-Cortex-Freshness": ctx.freshness.state,
    ETag: ctx.etag,
    "X-Content-Type-Options": "nosniff",
    ...(ctx.headers ?? {}),
  };

  const inm = ctx.req.headers["if-none-match"];
  if (typeof inm === "string" && inm === ctx.etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }

  // HEAD: stamp every header (incl. ETag) but send NO body, per HTTP semantics.
  res.writeHead(200, { ...baseHeaders, "Content-Type": "application/json" });
  res.end(ctx.req.method === "HEAD" ? undefined : JSON.stringify(data));
}

/** Error responses (no contract validation). */
export function respondError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify({ error: message }));
}
