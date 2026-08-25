import type { OriginFields } from "../git/origin.js";

export type StoryStatus = "open" | "closed";

export interface StoryStep {
  step_index: number; // 1-based
  caption: string;
  refs: string[];
  emphasis_edges: [string, string][];
  layout_hint: "network" | "organic" | null;
}

export interface Story {
  id: string; // "S-9m2x"
  seq: number;
  title: string;
  description: string;
  status: StoryStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  step_count: number;
}

export interface StoryWithSteps extends Story {
  steps: StoryStep[];
}

/** Row shape as stored/read by StoriesRepository. Kept structurally close to
 *  `Story` (mirrors the decisions/todos split); `rowToStory` fills in the
 *  computed `step_count`. */
export interface StoryRecord {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Git identity columns (authored-content provenance). Origin is stamped
  // once at create and never rewritten; last-touched is rewritten by every
  // mutating path. Optional so pre-existing inline literals typecheck — DB
  // rows always carry the columns (NULL until stamped). No basis_hash:
  // stories govern nothing, so there is no basis to hash.
  origin_branch?: string | null;
  origin_commit?: string | null;
  origin_thread?: string | null;
  last_touched_branch?: string | null;
  last_touched_commit?: string | null;
  last_touched_thread?: string | null;
}

export interface StoryStepRecord {
  story_id: string;
  step_index: number;
  caption: string;
  refs: string; // JSON
  emphasis_edges: string | null; // JSON
  layout_hint: string | null;
}

export interface CreateStoryInput {
  title: string;
  description?: string;
  created_by?: string;
  closed?: boolean; // explain-architecture creates already-closed
  steps: Array<{ caption: string; refs: string[]; emphasis_edges?: [string, string][]; layout_hint?: "network" | "organic" }>;
  links?: { decision_ids?: string[]; pr_number?: number };
  origin?: OriginFields; // git identity captured by the tool handler
}

export function rowToStory(rec: StoryRecord, stepCount: number): Story {
  return {
    id: rec.id,
    seq: rec.seq,
    title: rec.title,
    description: rec.description ?? "",
    status: rec.status as StoryStatus,
    created_by: rec.created_by ?? null,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    step_count: stepCount,
  };
}

export function rowToStep(rec: StoryStepRecord): StoryStep {
  const parse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    step_index: rec.step_index,
    caption: rec.caption,
    refs: parse<string[]>(rec.refs, []),
    emphasis_edges: parse<[string, string][]>(rec.emphasis_edges, []),
    layout_hint: rec.layout_hint === "network" || rec.layout_hint === "organic" ? rec.layout_hint : null,
  };
}
