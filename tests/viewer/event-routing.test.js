// tests/viewer/event-routing.test.js
import { describe, it, expect } from "vitest";
import { belongsToProject } from "../../src/viewer/app/event-routing.js";

describe("belongsToProject", () => {
  it("accepts an event for the project on screen", () => {
    expect(belongsToProject({ project_id: "cortex" }, "cortex")).toBe(true);
  });

  it("rejects an event for a different project", () => {
    expect(belongsToProject({ project_id: "mesh" }, "cortex")).toBe(false);
  });

  it("accepts an event with no project_id (pre-upgrade backfill)", () => {
    expect(belongsToProject({ project_id: "" }, "cortex")).toBe(true);
    expect(belongsToProject({}, "cortex")).toBe(true);
  });

  it("accepts anything before the active project is known", () => {
    expect(belongsToProject({ project_id: "mesh" }, null)).toBe(true);
  });
});
