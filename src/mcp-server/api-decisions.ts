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

export type GovernsRef =
  | { kind: "frame"; id: string; label: string }
  | { kind: "file"; path: string }
  | { kind: "function"; path: string; name: string }
  | { kind: "symbol"; path: string; name: string };

export interface AdaptedAlternative {
  title: string;
  reason: string;
}

export interface AdaptedDecision {
  id: string;
  summary: string;
  state: string;
  problem: string | null;
  resolution: string | null;
  rationale: string;
  alternatives: AdaptedAlternative[];
  proposedBy: string | null;
  proposedAt: string;
  governs: GovernsRef[];
  supersedes: string | null;
  supersededBy: string | null;
  relatedTo: string[];
  dependsOn: string[];
}

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

function resolveGovernsRef(
  link: DecisionLink,
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): GovernsRef[] {
  if (link.target_kind === "path") {
    if (!nodesByPath.has(link.target_ref)) return [];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(link.target_ref);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "file", path: link.target_ref });
    return out;
  }

  if (link.target_kind === "qn") {
    const sepIdx = link.target_ref.indexOf("::");
    if (sepIdx === -1) return [];
    const path = link.target_ref.slice(0, sepIdx);
    const name = link.target_ref.slice(sepIdx + 2);
    if (!nodesByPath.has(path)) return [];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(path);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "function", path, name });
    return out;
  }

  return [];
}
