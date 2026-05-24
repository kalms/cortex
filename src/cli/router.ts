export type ParsedArgv = {
  namespace: string | null;     // e.g. "code", or null for meta
  command: string | null;       // e.g. "search"
  positionals: string[];        // non-flag args after command
  flags: Record<string, string | boolean>;
};

export function parseArgv(argv: string[]): ParsedArgv {
  // argv[0] is the binary name (e.g. "cortex"); strip it.
  const args = argv.slice(1);
  let namespace: string | null = null;
  let command: string | null = null;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (a.startsWith("-")) {
      // Short flags — treat as boolean for now.
      flags[a.slice(1)] = true;
    } else if (namespace === null) {
      namespace = a;
    } else if (command === null) {
      command = a;
    } else {
      positionals.push(a);
    }
  }

  return { namespace, command, positionals, flags };
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

export function findSuggestion(typed: string, candidates: string[], maxDistance = 2): string | null {
  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(typed, c);
    if (d <= maxDistance && (best === null || d < best.d)) {
      best = { name: c, d };
    }
  }
  return best?.name ?? null;
}
