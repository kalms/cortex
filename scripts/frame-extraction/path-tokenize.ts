// scripts/frame-extraction/path-tokenize.ts
import { basename, dirname, extname, sep } from "node:path";
import type { PathTokenizeOptions, PathTokens } from "./types.js";

/**
 * Conventional path segments stripped before extracting domain tokens.
 * Source: docs/specs/cortex-v0.3/frame-extraction.md §Path tokenization.
 * Order doesn't matter; this is a set lookup.
 */
const STRIP_SEGMENTS = new Set([
  // Universal
  "src", "lib",
  // Frontend conventions
  "app", "pages", "components", "composables", "layouts", "middleware",
  "plugins", "stores", "views", "router",
  // Backend conventions
  "cmd", "internal", "pkg", "api", "controllers", "services", "models", "routes",
  // Test/build conventions
  "tests", "test", "__tests__", "spec", "docs", "dist", "build",
]);

/**
 * Role suffixes stripped from filenames (after extension removal).
 * The dot is part of the suffix in the source name (`auth.service.ts`).
 * Stored without the dot for set lookup against split parts.
 */
const ROLE_SUFFIXES = new Set([
  "service", "helper", "controller", "repository", "test", "spec",
]);

const DEFAULT_OPTS: PathTokenizeOptions = {
  service_suffix_aware: true,
};

/** Split an identifier into lowercase word parts, handling camelCase,
 *  consecutive-uppercase runs (URLParser, XMLHttpRequest), snake_case,
 *  kebab-case, and dotted (`foo.bar`) names uniformly. */
function splitWords(s: string): string[] {
  return s
    // First pass: insert space inside an uppercase run that's about to
    // transition to a CamelCase word. URLParser → URL Parser; XMLHttp → XML Http.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // Second pass: lowercase→uppercase boundary. invoiceList → invoice List.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._\-/]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

function dedupePreserveOrder(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/** Strip extension AND role-suffix from a bare filename, returning the
 *  remaining stem. `auth.service.ts` → `auth`; `invoice.test.tsx` →
 *  `invoice`. If `service_suffix_aware` is true and the stem-without-suffix
 *  is itself a STRIP_SEGMENTS member, restore the suffix so we don't lose
 *  the only domain signal. */
function stripFilename(filename: string, opts: PathTokenizeOptions): string {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  // Find the last dotted segment — that's the role candidate.
  const lastDot = stem.lastIndexOf(".");
  if (lastDot === -1) return stem;
  const candidate = stem.slice(lastDot + 1).toLowerCase();
  if (!ROLE_SUFFIXES.has(candidate)) return stem;
  const prefix = stem.slice(0, lastDot);
  if (opts.service_suffix_aware) {
    // If the prefix is itself a STRIP_SEGMENTS token, the suffix is the
    // only domain signal — keep it.
    const prefixWords = splitWords(prefix);
    const prefixIsAllStrip =
      prefixWords.length > 0 &&
      prefixWords.every((w) => STRIP_SEGMENTS.has(w));
    if (prefixIsAllStrip) return candidate;
  }
  return prefix;
}

export function tokenizePath(
  filePath: string,
  opts: Partial<PathTokenizeOptions> = {},
): PathTokens {
  const merged = { ...DEFAULT_OPTS, ...opts };
  const file = basename(filePath);
  const dir = dirname(filePath);

  // Path tokens: split the directory by separator, lowercase, drop strip-list.
  const dirSegments = dir
    .split(sep)
    .map((s) => s.toLowerCase())
    .filter((s) => s !== "" && s !== "." && !STRIP_SEGMENTS.has(s));

  // Also tokenize the filename stem into path_tokens (the basename carries
  // domain information just like its parent dirs). Strip role suffix first.
  const stem = stripFilename(file, merged);
  const stemWords = splitWords(stem).filter((w) => !STRIP_SEGMENTS.has(w));
  const allPath = [...dirSegments.flatMap(splitWords), ...stemWords];

  // Symbol tokens: only the stripped stem, split into words.
  return {
    path_tokens: dedupePreserveOrder(allPath),
    symbol_tokens: dedupePreserveOrder(stemWords),
  };
}
