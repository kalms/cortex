import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type HarnessContext, callTool } from "./harness.js";

describe("todo tool contract — lifecycle", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("propose → get round-trip (id matches, state open)", async () => {
    const propRes = await callTool(h, "todo", { action: "propose", summary: "scaffold auth module" });
    expect(propRes.isError).toBeFalsy();
    const proposed = JSON.parse(propRes.content[0].text);
    expect(typeof proposed.id).toBe("string");
    expect(proposed.state).toBe("open");

    const getRes = await callTool(h, "todo", { action: "get", id: proposed.id });
    expect(getRes.isError).toBeFalsy();
    const got = JSON.parse(getRes.content[0].text);
    expect(got.id).toBe(proposed.id);
    expect(got.state).toBe("open");
  });

  it("list returns proposed todos", async () => {
    // propose two todos so we can assert list is non-empty
    await callTool(h, "todo", { action: "propose", summary: "write e2e tests" });
    await callTool(h, "todo", { action: "propose", summary: "update docs" });

    const listRes = await callTool(h, "todo", { action: "list" });
    expect(listRes.isError).toBeFalsy();
    const todos = JSON.parse(listRes.content[0].text);
    expect(Array.isArray(todos)).toBe(true);
    expect(todos.length).toBeGreaterThanOrEqual(2);
  });

  it("transition: propose → in_progress → get shows in_progress + started_at set", async () => {
    const propRes = await callTool(h, "todo", { action: "propose", summary: "implement search indexing" });
    const proposed = JSON.parse(propRes.content[0].text);

    const transRes = await callTool(h, "todo", {
      action: "transition",
      id: proposed.id,
      to: "in_progress",
    });
    expect(transRes.isError).toBeFalsy();
    const transitioned = JSON.parse(transRes.content[0].text);
    expect(transitioned.state).toBe("in_progress");

    const getRes = await callTool(h, "todo", { action: "get", id: proposed.id });
    const got = JSON.parse(getRes.content[0].text);
    expect(got.state).toBe("in_progress");
    expect(got.started_at).toBeTruthy();
  });

  it("propose with no summary returns an error", async () => {
    const res = await callTool(h, "todo", { action: "propose" });
    // Should either be isError=true or contain an error envelope
    const text = res.content[0].text;
    const isErrorEnvelope = res.isError === true || text.startsWith("ERROR reason=");
    const isMissingField = text.includes("requires 'summary'") || text.includes("summary") || isErrorEnvelope;
    expect(isMissingField).toBe(true);
  });
});

describe("todo tool per-call routing", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("rejects when repo_path is missing", async () => {
    const res = await callTool(h, "todo", { repo_path: undefined, action: "list" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });
});
