import { empty, error as errorResponse } from "../response.js";

/**
 * Shared catch/normalize wrapper for action handler bodies.
 *
 * Runs `fn` and normalizes any thrown error to the standard error response:
 * "not found" errors map to `empty(label)` when a `label` is given, everything
 * else to `errorResponse("internal_error", msg)`. Handlers whose catch logic
 * differs from this exact shape (extra reason mapping, freshness attachment)
 * keep their own try/catch.
 */
export async function execAction<T>(label: string | null, fn: () => T | Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (label !== null && /not found/i.test(msg)) return empty(label);
    return errorResponse("internal_error", msg);
  }
}
