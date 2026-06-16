/**
 * Hardening middleware for the viewer HTTP server (spec §4). Each guard is a
 * small pure function; the server composes them (method → CORS → auth) before
 * dispatch, plus a request-target length limit and traversal-safe static
 * resolution. Config is via env vars (matches how Mesh spawns the sidecar). All
 * defaults are inert for the local single-user case.
 */
import { timingSafeEqual } from "node:crypto";
import { resolve, join, sep } from "node:path";

type Env = Record<string, string | undefined>;

/** Endpoints reachable without a bearer token even when auth is enabled.
 *  ONLY non-sensitive liveness — never `/api/projects` (it leaks root_path). */
export const AUTH_EXEMPT = new Set<string>(["/api/health"]);

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

/** Bind interface. Loopback by default; `0.0.0.0` to deliberately expose. */
export function resolveBindHost(env: Env = process.env): string {
  return env.CORTEX_BIND_HOST?.trim() || "127.0.0.1";
}

export function methodAllowed(method: string | undefined): boolean {
  return method !== undefined && ALLOWED_METHODS.has(method);
}

/** Reject an over-long request target — cheap oversized-URL / request-line guard
 *  (spec §4 row 7). */
export const MAX_URL_LENGTH = 2048;
export function urlTooLong(url: string | undefined): boolean {
  return (url?.length ?? 0) > MAX_URL_LENGTH;
}

/** CORS headers for a request Origin. Empty unless the origin is allowlisted via
 *  CORTEX_CORS_ORIGINS (comma-separated). Mesh fetches from Node (no CORS), so
 *  the default empty allowlist costs it nothing. */
export function corsHeadersFor(origin: string | undefined, env: Env = process.env): Record<string, string> {
  if (!origin) return {};
  const allow = (env.CORTEX_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, If-None-Match",
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True if the request is authorized. No token configured → always true. The
 *  liveness path in AUTH_EXEMPT is always allowed. `pathname` must be the URL
 *  path WITHOUT query string. */
export function checkAuth(pathname: string, authHeader: string | undefined, env: Env = process.env): boolean {
  const token = env.CORTEX_API_TOKEN?.trim();
  if (!token) return true;
  if (AUTH_EXEMPT.has(pathname)) return true;
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  return safeEqual(authHeader.slice(prefix.length), token);
}

/** Resolve a static-file request safely. Returns the absolute path only if it
 *  stays within `viewerDir`; null on any traversal escape. */
export function safeStaticPath(viewerDir: string, rel: string): string | null {
  const base = resolve(viewerDir);
  const full = resolve(join(base, rel));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/** Baseline security headers for served documents/assets. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};
