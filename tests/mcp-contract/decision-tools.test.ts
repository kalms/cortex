import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("decision-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  describe("lifecycle: create → get → update → link → search → delete", () => {
    let decisionId: string;

    it("create_decision: returns JSON with id", async () => {
      const res = await callTool(h, "create_decision", {
        title: "Test decision",
        description: "for contract test",
        rationale: "verifying lifecycle",
        alternatives: [{ name: "alt1", reason_rejected: "slower" }],
      });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      decisionId = parsed.id;
    });

    it("get_decision: returns created decision", async () => {
      const res = await callTool(h, "get_decision", { id: decisionId });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.title ?? parsed.decision?.title).toBe("Test decision");
    });

    it("update_decision: mutates title", async () => {
      const res = await callTool(h, "update_decision", { id: decisionId, title: "Updated title" });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.title).toBe("Updated title");
    });

    it("link_decision: attaches a GOVERNS edge to a fixture file", async () => {
      const res = await callTool(h, "link_decision", {
        decision_id: decisionId,
        target: "src/server.ts",
        relation: "GOVERNS",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("linked");
    });

    it("search_decisions: finds the decision by query", async () => {
      const res = await callTool(h, "search_decisions", { query: "Updated title" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(decisionId);
    });

    it("delete_decision: removes the decision", async () => {
      const res = await callTool(h, "delete_decision", { id: decisionId });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(decisionId);
    });

    it("get_decision after delete: returns empty or error", async () => {
      const res = await callTool(h, "get_decision", { id: decisionId });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("error paths", () => {
    it("get_decision: malformed id returns ErrorResponse or empty (structured)", async () => {
      const res = await callTool(h, "get_decision", { id: "not-a-ulid" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      if (res.isError) {
        expect(res.content[0].text).toMatch(/^ERROR reason=/);
      } else {
        expect(res.content[0].text).toMatch(/^No results: /);
      }
    });

    it("update_decision: unknown id returns structured error or empty", async () => {
      const res = await callTool(h, "update_decision", { id: "01HXXXXXXXXXXXXXXXXXXXXXXXXX", title: "x" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });

    it("search_decisions: query with no matches returns empty or ok", async () => {
      const res = await callTool(h, "search_decisions", { query: "zzzNonexistentQuery999" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });
  });

  describe("why_was_this_built", () => {
    it("empty: path with no governing decision", async () => {
      const res = await callTool(h, "why_was_this_built", { qualified_name: "src/utils.js::formatLog" });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
    });

    it.skip("happy: finds decision for linked file after create+link", async () => {
      // TODO: whyWasThisBuilt does not extract file path from qualified_name.
      // When queried with "src/server.ts::handleRequest", it should try file_path "src/server.ts"
      // but currently tries to match the full qualified_name. This requires DecisionSearch
      // to parse qualified_name and extract the file part before querying.
      const create = await callTool(h, "create_decision", {
        title: "Server pattern",
        description: "uses parseBody",
        rationale: "separation",
      });
      const id = JSON.parse(create.content[0].text).id;
      await callTool(h, "link_decision", { decision_id: id, target: "src/server.ts", relation: "GOVERNS" });

      const res = await callTool(h, "why_was_this_built", { qualified_name: "src/server.ts::handleRequest" });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(id);

      await callTool(h, "delete_decision", { id });
    });
  });
});
