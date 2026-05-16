import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type HarnessContext, callTool } from "./harness.js";

describe("decision extensions contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("propose_decision creates status=proposed and is readable via get_decision", async () => {
    const r = await callTool(h, "propose_decision", {
      title: "D1",
      problem: "p",
      resolution: "r",
      rationale: "why",
    });
    const d = JSON.parse(r.content[0].text);
    expect(d.status).toBe("proposed");
    expect(d.problem).toBe("p");
    expect(d.resolution).toBe("r");

    const g = JSON.parse((await callTool(h, "get_decision", { id: d.id })).content[0].text);
    expect(g.status).toBe("proposed");
    expect(g.problem).toBe("p");
  });

  it("supersede_decision atomic: old becomes superseded, new is active, superseded_by backlink set", async () => {
    const a = JSON.parse(
      (await callTool(h, "create_decision", {
        title: "old", description: "d", rationale: "r", problem: "p", resolution: "res",
      })).content[0].text
    );
    const b = JSON.parse(
      (await callTool(h, "supersede_decision", {
        old_decision_id: a.id, title: "new", problem: "np", resolution: "nr", rationale: "why",
      })).content[0].text
    );
    expect(b.status).toBe("active");
    const ga = JSON.parse((await callTool(h, "get_decision", { id: a.id })).content[0].text);
    expect(ga.status).toBe("superseded");
    expect(ga.superseded_by).toBe(b.id);
  });

  it("link_decision supports RELATED_TO and DEPENDS_ON", async () => {
    const a = JSON.parse((await callTool(h, "create_decision", { title: "A", description: "d", rationale: "r" })).content[0].text);
    const b = JSON.parse((await callTool(h, "create_decision", { title: "B", description: "d", rationale: "r" })).content[0].text);
    const c = JSON.parse((await callTool(h, "create_decision", { title: "C", description: "d", rationale: "r" })).content[0].text);

    await callTool(h, "link_decision", { decision_id: a.id, target: b.id, relation: "RELATED_TO" });
    await callTool(h, "link_decision", { decision_id: a.id, target: c.id, relation: "DEPENDS_ON" });

    const view = JSON.parse((await callTool(h, "get_decision", { id: a.id })).content[0].text);
    expect(view.related_decisions.map((d: any) => d.id)).toContain(b.id);
    expect(view.depends_on.map((d: any) => d.id)).toContain(c.id);
  });

  // The "legacy decision" test was removed when decisions moved out of the
  // graph DB into a sibling .cortex/decisions.db (commit af983d8 + later).
  // Writing a node with kind='decision' directly into the graph store no
  // longer surfaces in get_decision because that path now reads from the
  // sidecar exclusively. Migration of legacy rows is handled at server
  // startup via migrateDecisionsFromGraphDb().

  it("search_decisions finds matches on new problem field", async () => {
    await callTool(h, "propose_decision", {
      title: "Z", problem: "unicorn banana rarity", resolution: "x", rationale: "r",
    });
    const r = await callTool(h, "search_decisions", { query: "unicorn" });
    expect(r.content[0].text).toContain("unicorn");
  });

  it("get_decision preserves governs and references arrays (regression for I1)", async () => {
    // Create a decision with a governed file path
    const created = JSON.parse(
      (await callTool(h, "create_decision", {
        title: "GovRef",
        description: "d",
        rationale: "r",
        problem: "p",
        resolution: "res",
        governs: ["src/viewer/projection.js"],
      })).content[0].text
    );
    const view = JSON.parse(
      (await callTool(h, "get_decision", { id: created.id })).content[0].text
    );
    expect(Array.isArray(view.governs)).toBe(true);
    expect(view.governs.length).toBeGreaterThanOrEqual(1);
    // references can be empty but must be present
    expect(Array.isArray(view.references)).toBe(true);
  });
});
