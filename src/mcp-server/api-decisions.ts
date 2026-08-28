// src/mcp-server/api-decisions.ts
/**
 * Adapter: DecisionRecord + DecisionLink rows from the sidecar decisions DB
 * into the shape the prototype-derived viewer consumes (renderDecisionCard,
 * marginalia pills). Pure functions — fully unit-testable.
 *
 * Output shape matches the prototype's hardcoded DECISIONS[id] consumers in
 * docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html.
 */
import type { DecisionRecord } from "../decisions/repository.js";
import type { DecisionLink } from "../decisions/links-repository.js";
import type { NodeRow } from "../graph/store.js";
import type { GovernsRef, AdaptedAlternative, AdaptedDecision } from "./api-schemas.js";

// Types now derive from the Zod single source of truth (api-schemas.ts).
export type { GovernsRef, AdaptedAlternative, AdaptedDecision } from "./api-schemas.js";

export interface FrameInfo {
  frame_id: number;
  frame_label: string;
}

export function buildAdaptedDecision(
  rec: DecisionRecord,
  links: DecisionLink[],
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): AdaptedDecision {
  const alternatives: AdaptedAlternative[] = parseAlternatives(rec.alternatives);

  const governs: GovernsRef[] = [];
  const seenFrames = new Set<string>();
  let supersedes: string | null = null;
  const relatedTo: string[] = [];
  const dependsOn: string[] = [];

  for (const link of links) {
    if (link.decision_id !== rec.id) continue;

    if (link.relation === "GOVERNS") {
      const refs = resolveGovernsRef(link, nodesByPath, framesByPath);
      for (const r of refs) {
        if (r.kind === "frame") {
          if (seenFrames.has(r.id)) continue;
          seenFrames.add(r.id);
        }
        governs.push(r);
      }
    } else if (link.relation === "SUPERSEDES" && link.target_kind === "decision") {
      supersedes = link.target_ref;
    } else if (link.relation === "DECISION_RELATED_TO" && link.target_kind === "decision") {
      relatedTo.push(link.target_ref);
    } else if (link.relation === "DECISION_DEPENDS_ON" && link.target_kind === "decision") {
      dependsOn.push(link.target_ref);
    }
  }

  return {
    id: rec.id,
    seq: rec.seq ?? null,
    summary: rec.title,
    state: rec.status,
    problem: rec.problem,
    resolution: rec.resolution,
    rationale: rec.rationale ?? "",
    alternatives,
    proposedBy: rec.author,
    proposedAt: rec.created_at,
    governs,
    supersedes,
    supersededBy: rec.superseded_by,
    relatedTo,
    dependsOn,
    provenance: rec.provenance ? JSON.parse(rec.provenance) : null,
    originBranch: rec.origin_branch ?? null,
    originCommit: rec.origin_commit ?? null,
    originThread: rec.origin_thread ?? null,
    lastTouchedBranch: rec.last_touched_branch ?? null,
    lastTouchedCommit: rec.last_touched_commit ?? null,
    lastTouchedThread: rec.last_touched_thread ?? null,
    basisHash: rec.basis_hash ?? null,
    reconciledBranch: rec.reconciled_branch ?? null,
    reconciledCommit: rec.reconciled_commit ?? null,
  };
}

export function buildAdaptedDecisions(
  records: DecisionRecord[],
  links: DecisionLink[],
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): AdaptedDecision[] {
  return records.map((rec) =>
    buildAdaptedDecision(rec, links, nodesByPath, framesByPath),
  );
}

function parseAlternatives(raw: string | null): AdaptedAlternative[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ name: string; reason_rejected: string }>;
    return parsed.map((a) => ({ title: a.name, reason: a.reason_rejected }));
  } catch {
    return [];
  }
}

/** A ref the graph has no node for. Emitted rather than dropped — see the
 *  `unresolved` variant's note in api-schemas.ts. */
function unresolvedRef(ref: string, path: string | null): GovernsRef {
  return { kind: "unresolved", ref, path, reason: "not-in-graph" };
}

export function resolveGovernsRef(
  link: { target_kind: string; target_ref: string },
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): GovernsRef[] {
  if (link.target_kind === "path") {
    if (!nodesByPath.has(link.target_ref)) return [unresolvedRef(link.target_ref, link.target_ref)];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(link.target_ref);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "file", path: link.target_ref });
    return out;
  }

  if (link.target_kind === "qn") {
    const sepIdx = link.target_ref.indexOf("::");
    // No "::" — not a qualified name we can split, so there is no path to show.
    if (sepIdx === -1) return [unresolvedRef(link.target_ref, null)];
    const path = link.target_ref.slice(0, sepIdx);
    const name = link.target_ref.slice(sepIdx + 2);
    if (!nodesByPath.has(path)) return [unresolvedRef(link.target_ref, path)];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(path);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "function", path, name });
    return out;
  }

  // decision / pr / todo targets are not code refs; they are surfaced through
  // their own relations, so they stay out of `governs` entirely.
  return [];
}
