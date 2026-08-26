/**
 * Adapter: StoryRecord + StoryStepRecord rows from the stories sidecar DB
 * into the wire shape the HTTP API serves (AdaptedStory / AdaptedStoryDetail).
 *
 * Pure functions — fully unit-testable, no IO or DB access. Mirrors the
 * api-todos.ts idiom: wire fields are camelCase (`createdBy`, `stepCount`…)
 * while the DB record is snake_case; `rowToStep` (src/stories/types.ts) does
 * the JSON parsing for individual steps.
 */
import type { StoryRecord, StoryStepRecord } from "../stories/types.js";
import { rowToStep } from "../stories/types.js";
import type { AdaptedStory, AdaptedStoryDetail } from "./api-schemas.js";

export function buildAdaptedStory(rec: StoryRecord, stepCount: number): AdaptedStory {
  return {
    id: rec.id,
    seq: rec.seq ?? null,
    title: rec.title,
    description: rec.description ?? "",
    status: rec.status,
    createdBy: rec.created_by ?? null,
    createdAt: rec.created_at,
    updatedAt: rec.updated_at,
    stepCount,
    originBranch: rec.origin_branch ?? null,
    originCommit: rec.origin_commit ?? null,
    originThread: rec.origin_thread ?? null,
    lastTouchedBranch: rec.last_touched_branch ?? null,
    lastTouchedCommit: rec.last_touched_commit ?? null,
    lastTouchedThread: rec.last_touched_thread ?? null,
  };
}

export function buildAdaptedStoryDetail(rec: StoryRecord, steps: StoryStepRecord[]): AdaptedStoryDetail {
  return {
    ...buildAdaptedStory(rec, steps.length),
    steps: steps.map(rowToStep),
  };
}
