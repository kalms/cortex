// src/frame-extraction/eval-labels.ts
/**
 * Label-quality checker for the frame-extraction eval guardrail.
 *
 * PURE module: given clusters + their top tokens, it runs the EXISTING
 * labeler (`pickFrameLabel`) over each cluster and flags rule violations.
 * It does NOT fix labels — it MEASURES them so we have a baseline for the
 * field-assessment failures (framework idioms leaking in, MVC layer
 * markers standing alone, single-member labels misrepresenting clusters).
 *
 * No file/DB/network I/O. Inputs in, violations out.
 */
import { pickFrameLabel } from "./inject-frames.js";
import type { ClusterAssignment } from "./types.js";

/** Structural-not-topical tokens that must never stand as a frame label.
 *  Shared with Phase 1's tokenizer when it lands. Lowercase. */
export const STRUCTURAL_LABEL_TOKENS = new Set<string>([
  "use",
  "controller", "controllers", "model", "models", "view", "views",
  "serializer", "serializers", "migration", "migrations", "schema",
]);

/** True if a token is a bracketed dynamic route segment or a structural token. */
export function isStructuralLabelToken(token: string): boolean {
  const t = token.toLowerCase();
  if (/^\[.*\]$/.test(t) || /^\(.*\)$/.test(t)) return true;
  return STRUCTURAL_LABEL_TOKENS.has(t);
}

/** Lowercased route-param names appearing as bracketed segments in paths.
 *  e.g. ".../[orgId]/..." -> "orgid", "[...slug]" -> "slug". */
export function routeParamTokens(memberPaths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of memberPaths) {
    for (const seg of p.split("/")) {
      const m = seg.match(/^\[\.{0,3}(.+?)\]$/); // [x], [...x]
      if (m) out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

export interface LabelViolation {
  cluster_id: number;
  label: string;
  rule: "structural_token_in_label" | "non_salient_label";
  detail: string;
}

/**
 * Fraction of member paths that contain `token` as a substring.
 *
 * Known limitations (acceptable for a measurement baseline):
 * (a) Uses substring matching (`includes`), so "api" hits "capital" or "apiary".
 * (b) Salience is checked per-word, so a legitimate bigram whose rarer half
 *     appears in <50 % of paths can trigger a false `non_salient_label` hit.
 */
function pathSalience(token: string, memberPaths: readonly string[]): number {
  if (memberPaths.length === 0) return 0;
  const t = token.toLowerCase();
  let hits = 0;
  for (const p of memberPaths) if (p.toLowerCase().includes(t)) hits++;
  return hits / memberPaths.length;
}

/** Run the current labeler over each cluster and return rule violations. */
export function checkLabelQuality(
  clusters: readonly ClusterAssignment[],
  topTokensPerCluster: Record<string, string[]>,
): LabelViolation[] {
  const out: LabelViolation[] = [];
  for (const c of clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokensPerCluster[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.member_paths, c.cluster_id);
    const words = label.toLowerCase().split(/\s+/).filter(Boolean);

    const params = routeParamTokens(c.member_paths);
    const bad = words.find((w) => isStructuralLabelToken(w) || params.has(w));
    if (bad) {
      out.push({ cluster_id: c.cluster_id, label, rule: "structural_token_in_label", detail: bad });
      continue;
    }
    const weak = words.find((w) => pathSalience(w, c.member_paths) < 0.5);
    if (weak) {
      out.push({ cluster_id: c.cluster_id, label, rule: "non_salient_label", detail: weak });
    }
  }
  return out;
}
