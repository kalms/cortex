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
import {
  STRUCTURAL_LABEL_TOKENS,
  isStructuralLabelToken,
  routeParamTokens,
  pathSalience,
} from "./structural-tokens.js";
import type { ClusterAssignment } from "./types.js";

// Re-export the shared vocabulary so existing importers of eval-labels keep
// working; the single source of truth now lives in structural-tokens.ts.
// pathSalience is intentionally NOT re-exported — it was private before this refactor.
export { STRUCTURAL_LABEL_TOKENS, isStructuralLabelToken, routeParamTokens };

export interface LabelViolation {
  cluster_id: number;
  label: string;
  rule: "structural_token_in_label" | "non_salient_label";
  detail: string;
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
