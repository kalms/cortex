import type Database from "better-sqlite3";
import { mintId } from "../ids/allocator.js";
import { parseRef } from "../ids/short-id.js";
import { StoriesRepository, StoryStepsRepository } from "./repository.js";
import { StoryLinksRepository } from "./links-repository.js";
import { rowToStory, rowToStep, type Story, type StoryRecord, type StoryWithSteps, type CreateStoryInput } from "./types.js";

export interface StoryServiceDeps {
  db: Database.Database; // constructs its own repos, mirrors none — stories need no bus
}

export class StoryService {
  private db: Database.Database;
  private stories: StoriesRepository;
  private steps: StoryStepsRepository;
  private links: StoryLinksRepository;

  constructor(deps: StoryServiceDeps) {
    this.db = deps.db;
    this.stories = new StoriesRepository(this.db);
    this.steps = new StoryStepsRepository(this.db);
    this.links = new StoryLinksRepository(this.db);
  }

  private resolveRecord(ref: string): StoryRecord | null {
    const direct = this.stories.get(ref);
    if (direct) return direct;
    const parsed = parseRef("story", ref);
    if (!parsed) return null;
    return parsed.kind === "seq" ? this.stories.getBySeq(parsed.seq) : this.stories.get(parsed.id);
  }

  create(input: CreateStoryInput): StoryWithSteps {
    if (!input.steps || input.steps.length === 0) throw new Error("story requires at least one step");
    const now = new Date().toISOString();
    return this.db.transaction((): StoryWithSteps => {
      const { id, seq } = mintId(this.db, "story", (cand) => this.stories.get(cand) != null);
      const rec: StoryRecord = {
        id, seq, title: input.title, description: input.description ?? null,
        status: input.closed ? "closed" : "open", created_by: input.created_by ?? "claude",
        created_at: now, updated_at: now,
      };
      this.stories.insert(rec);
      this.steps.insertAll(input.steps.map((s, i) => ({
        story_id: id, step_index: i + 1, caption: s.caption,
        refs: JSON.stringify(s.refs),
        emphasis_edges: s.emphasis_edges?.length ? JSON.stringify(s.emphasis_edges) : null,
        layout_hint: s.layout_hint ?? null,
      })));
      for (const d of input.links?.decision_ids ?? [])
        this.links.add({ story_id: id, target_kind: "decision", target_ref: d, relation: "ABOUT", created_at: now });
      if (input.links?.pr_number != null)
        this.links.add({ story_id: id, target_kind: "pr", target_ref: String(input.links.pr_number), relation: "ABOUT", created_at: now });
      return { ...rowToStory(rec, input.steps.length), steps: this.steps.listByStory(id).map(rowToStep) };
    })();
  }

  get(idOrSeq: string): StoryWithSteps | null {
    const rec = this.resolveRecord(idOrSeq);
    if (!rec) return null;
    const steps = this.steps.listByStory(rec.id);
    return { ...rowToStory(rec, steps.length), steps: steps.map(rowToStep) };
  }

  list(): Story[] {
    const counts = this.stories.stepCounts();
    return this.stories.list().map((rec) => rowToStory(rec, counts.get(rec.id) ?? 0));
  }

  close(idOrSeq: string): Story {
    const existing = this.resolveRecord(idOrSeq);
    if (!existing) throw new Error(`Story not found: ${idOrSeq}`);
    if (existing.status !== "closed") {
      const now = new Date().toISOString();
      this.stories.setStatus(existing.id, "closed", now);
      existing.status = "closed";
      existing.updated_at = now;
    }
    return rowToStory(existing, this.steps.countByStory(existing.id));
  }

  delete(idOrSeq: string): boolean {
    const existing = this.resolveRecord(idOrSeq);
    if (!existing) return false;
    return this.stories.delete(existing.id);
  }

  /** advance pre-flight: throws "Story not found: X" | "Story S-x is closed" | "Step 9 out of range (story has 3 steps)". Returns the resolved story. */
  checkAdvance(idOrSeq: string, step: number): StoryWithSteps {
    const existing = this.resolveRecord(idOrSeq);
    if (!existing) throw new Error(`Story not found: ${idOrSeq}`);
    if (existing.status === "closed") throw new Error(`Story ${existing.id} is closed`);
    const steps = this.steps.listByStory(existing.id);
    if (step < 1 || step > steps.length) throw new Error(`Step ${step} out of range (story has ${steps.length} steps)`);
    return { ...rowToStory(existing, steps.length), steps: steps.map(rowToStep) };
  }
}
