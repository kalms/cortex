// tests/api/api-stories.test.ts
import { describe, it, expect } from "vitest";
import { buildAdaptedStory, buildAdaptedStoryDetail } from "../../src/mcp-server/api-stories.js";
import { AdaptedStorySchema, AdaptedStoryDetailSchema } from "../../src/mcp-server/api-schemas.js";

const now = "2026-07-24T00:00:00.000Z";

const rec = {
  id: "S-abcd",
  seq: 3,
  title: "T",
  description: null,
  status: "open",
  created_by: "claude",
  created_at: now,
  updated_at: now,
};

const steps = [
  { story_id: "S-abcd", step_index: 1, caption: "c", refs: '["src/a.ts"]', emphasis_edges: null, layout_hint: null },
];

describe("buildAdaptedStory / buildAdaptedStoryDetail", () => {
  it("produces schema-valid AdaptedStory output", () => {
    expect(() => AdaptedStorySchema.parse(buildAdaptedStory(rec as any, 1))).not.toThrow();
  });

  it("produces schema-valid AdaptedStoryDetail output and parses steps", () => {
    const detail = buildAdaptedStoryDetail(rec as any, steps as any);
    expect(() => AdaptedStoryDetailSchema.parse(detail)).not.toThrow();
    expect(detail.steps[0]).toEqual({
      step_index: 1,
      caption: "c",
      refs: ["src/a.ts"],
      emphasis_edges: [],
      layout_hint: null,
    });
    expect(detail.description).toBe("");
  });

  it("maps record fields to camelCase wire fields", () => {
    const s = buildAdaptedStory(rec as any, 1);
    expect(s.id).toBe("S-abcd");
    expect(s.seq).toBe(3);
    expect(s.title).toBe("T");
    expect(s.status).toBe("open");
    expect(s.createdBy).toBe("claude");
    expect(s.createdAt).toBe(now);
    expect(s.updatedAt).toBe(now);
    expect(s.stepCount).toBe(1);
  });

  it("defaults createdBy to null when absent", () => {
    const s = buildAdaptedStory({ ...rec, created_by: null } as any, 0);
    expect(s.createdBy).toBeNull();
  });
});
