import type Database from "better-sqlite3";

export interface StoryLink {
  story_id: string;
  target_kind: string;
  target_ref: string;
  relation: string;
  created_at: string;
}

const COLS = "story_id, target_kind, target_ref, relation, created_at";

export class StoryLinksRepository {
  constructor(private db: Database.Database) {}

  add(link: StoryLink): void {
    this.db.prepare(
      `INSERT INTO story_links (${COLS})
       VALUES (@story_id, @target_kind, @target_ref, @relation, @created_at)`,
    ).run(link);
  }

  findByStory(storyId: string): StoryLink[] {
    return this.db.prepare(`SELECT ${COLS} FROM story_links WHERE story_id = ?`).all(storyId) as StoryLink[];
  }
}
