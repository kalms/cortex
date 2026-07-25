import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";

describe("stories schema", () => {
  it("creates stories, story_steps, story_links on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-stories-"));
    const db = openDecisionsDb(join(dir, "decisions.db"));
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stories','story_steps','story_links')",
    ).all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["stories", "story_links", "story_steps"]);
    // steps cascade with their story
    const now = new Date().toISOString();
    db.prepare("INSERT INTO stories (id, seq, title, status, created_at, updated_at) VALUES ('S-aaaa', 1, 't', 'open', ?, ?)").run(now, now);
    db.prepare("INSERT INTO story_steps (story_id, step_index, caption, refs) VALUES ('S-aaaa', 1, 'c', '[]')").run();
    db.prepare("DELETE FROM stories WHERE id = 'S-aaaa'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_steps").get()).toEqual({ n: 0 });
    db.close();
  });
});
