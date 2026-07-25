import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { StoriesRepository, StoryStepsRepository } from "../../src/stories/repository.js";
import { StoryLinksRepository } from "../../src/stories/links-repository.js";
import { rowToStory, rowToStep } from "../../src/stories/types.js";

const now = new Date().toISOString();
const mkDb = () => openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-st-")), "d.db"));

describe("StoriesRepository", () => {
  it("round-trips a story with steps and links", () => {
    const db = mkDb();
    const stories = new StoriesRepository(db);
    const steps = new StoryStepsRepository(db);
    const links = new StoryLinksRepository(db);
    stories.insert({ id: "S-abcd", seq: 1, title: "Walkthrough", description: null, status: "open", created_by: "claude", created_at: now, updated_at: now });
    steps.insertAll([
      { story_id: "S-abcd", step_index: 1, caption: "First", refs: JSON.stringify(["src/a.ts"]), emphasis_edges: null, layout_hint: null },
      { story_id: "S-abcd", step_index: 2, caption: "Second", refs: JSON.stringify(["D-zwrt"]), emphasis_edges: JSON.stringify([["src/a.ts", "src/b.ts"]]), layout_hint: "network" },
    ]);
    links.add({ story_id: "S-abcd", target_kind: "decision", target_ref: "D-zwrt", relation: "ABOUT", created_at: now });

    expect(stories.get("S-abcd")?.title).toBe("Walkthrough");
    expect(stories.getBySeq(1)?.id).toBe("S-abcd");
    expect(steps.countByStory("S-abcd")).toBe(2);
    expect(stories.stepCounts().get("S-abcd")).toBe(2);
    const parsed = steps.listByStory("S-abcd").map(rowToStep);
    expect(parsed[1]).toEqual({ step_index: 2, caption: "Second", refs: ["D-zwrt"], emphasis_edges: [["src/a.ts", "src/b.ts"]], layout_hint: "network" });
    expect(links.findByStory("S-abcd")).toHaveLength(1);
    expect(rowToStory(stories.get("S-abcd")!, 2).step_count).toBe(2);

    expect(stories.delete("S-abcd")).toBe(true);
    expect(steps.countByStory("S-abcd")).toBe(0);   // cascade
    db.close();
  });
  it("rowToStep degrades corrupt JSON to empty refs", () => {
    expect(rowToStep({ story_id: "S-x", step_index: 1, caption: "c", refs: "{nope", emphasis_edges: "also-bad", layout_hint: null }))
      .toEqual({ step_index: 1, caption: "c", refs: [], emphasis_edges: [], layout_hint: null });
  });
});
