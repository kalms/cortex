// tests/events/show-events.test.ts
// The three show-your-work event builders: envelope identity + payload shape.
import { describe, it, expect } from "vitest";
import { presenceActivityEvent, showFocusEvent, showAdvanceEvent } from "../../src/events/show-events.js";

const target = { name: "home-wt", root_path: "/repos/home-wt" };
const ID = "01J00000000000000000000000";
const NOW = 1721700000000;

describe("presenceActivityEvent", () => {
  it("stamps project_id with the registry name and carries the checkout", () => {
    const ev = presenceActivityEvent(
      { session_id: "s-1", repo_path: "/repos/home-wt/src", workspace: "home-wt", activity: "edited", refs: ["src/a.ts"] },
      target, ID, NOW,
    );
    expect(ev).toEqual({
      id: ID,
      kind: "presence.activity",
      actor: "claude",
      created_at: NOW,
      project_id: "home-wt",
      payload: { session_id: "s-1", workspace: "home-wt", repo_path: "/repos/home-wt", activity: "edited", refs: ["src/a.ts"] },
    });
  });

  it("uses the RESOLVED checkout, not the posted path", () => {
    const ev = presenceActivityEvent(
      { session_id: "s-1", repo_path: "/repos/home-wt/src/deep", workspace: "x", activity: "studied", refs: ["a"] },
      target, ID, NOW,
    );
    expect((ev.payload as { repo_path: string }).repo_path).toBe("/repos/home-wt");
  });
});

describe("showFocusEvent", () => {
  it("carries refs, note and the checkout", () => {
    const ev = showFocusEvent({ repo_path: "/repos/home-wt", refs: ["src/a.ts"], note: "here" }, target, ID, NOW);
    expect(ev).toMatchObject({
      kind: "show.focus",
      project_id: "home-wt",
      payload: { refs: ["src/a.ts"], note: "here", repo_path: "/repos/home-wt" },
    });
  });

  it("omits note when absent", () => {
    const ev = showFocusEvent({ repo_path: "/repos/home-wt", refs: [] }, target, ID, NOW);
    expect((ev.payload as { note?: string }).note).toBeUndefined();
  });
});

describe("showAdvanceEvent", () => {
  it("carries story id, step and the checkout", () => {
    const ev = showAdvanceEvent({ repo_path: "/repos/home-wt", story_id: "S-50vj", step: 3 }, target, ID, NOW);
    expect(ev).toMatchObject({
      kind: "show.advance",
      project_id: "home-wt",
      payload: { story_id: "S-50vj", step: 3, repo_path: "/repos/home-wt" },
    });
  });
});
