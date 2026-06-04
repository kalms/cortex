// src/frame-extraction/structural-tokens.ts
/**
 * Structural-not-topical token vocabulary, shared by the path tokenizer,
 * the frame labeler, and the eval label-quality checker.
 *
 * A "structural" token names a file's framework ROLE — a route param, a
 * composable prefix, an HTTP method, an MVC layer marker — rather than its
 * DOMAIN. Structural tokens are dropped/normalised during tokenization and
 * are ineligible as frame labels, so a frame is named after what it is
 * ABOUT, not how the framework wires it.
 *
 * Pure leaf module: no I/O, no imports from elsewhere in frame-extraction,
 * so path-tokenize / inject-frames / eval-labels can all depend on it
 * without creating an import cycle.
 */

/** MVC / convention layer markers that must never stand alone as a label. */
export const STRUCTURAL_LABEL_TOKENS = new Set<string>([
  "use",
  "controller", "controllers", "model", "models", "view", "views",
  "serializer", "serializers", "migration", "migrations", "schema",
]);

/** HTTP method suffixes used by file-based routers (Nuxt `server/api`,
 *  SvelteKit) as a trailing dotted segment: `users.get.ts`, `auth.post.ts`. */
export const ROUTE_METHOD_TOKENS = new Set<string>([
  "get", "post", "put", "patch", "delete", "head", "options",
]);

/** True for a bracketed dynamic route segment (`[id]`, `[...slug]`) or a
 *  parenthesised route group (`(group)` in Next.js App Router). */
export function isDynamicSegment(seg: string): boolean {
  return /^\[.*\]$/.test(seg) || /^\(.*\)$/.test(seg);
}

/** True if a token is structural-not-topical: a bracketed/group segment or a
 *  member of the MVC/convention marker set. Case-insensitive. */
export function isStructuralLabelToken(token: string): boolean {
  const t = token.toLowerCase();
  if (isDynamicSegment(t)) return true;
  return STRUCTURAL_LABEL_TOKENS.has(t);
}

/** Lowercased route-param names appearing as bracketed segments in member
 *  paths. e.g. `.../[orgId]/...` -> "orgid"; `[...slug].vue` -> "slug". */
export function routeParamTokens(memberPaths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of memberPaths) {
    for (const seg of p.split("/")) {
      // Strip any trailing file extension so `[...slug].vue` -> `[...slug]`
      const bare = seg.replace(/\.[^.[\]]+$/, "");
      const m = bare.match(/^\[\.{0,3}(.+?)\]$/); // [x] and [...x]
      if (m) out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

/**
 * Fraction of `memberPaths` containing `token` as a (lowercased) substring.
 *
 * Used by the labeler's salience gate: a token that names < 50% of a
 * cluster's files is not representative enough to be the frame label.
 * Substring matching is intentional (cheap; a domain noun usually appears in
 * the path). Known over-match cases (e.g. "api" inside "capital") are
 * acceptable for v1 — they only ever make a token look MORE salient, never
 * less, so they cannot wrongly reject a good label.
 */
export function pathSalience(token: string, memberPaths: readonly string[]): number {
  if (memberPaths.length === 0) return 0;
  const t = token.toLowerCase();
  let hits = 0;
  for (const p of memberPaths) if (p.toLowerCase().includes(t)) hits++;
  return hits / memberPaths.length;
}
