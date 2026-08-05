import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

// Mesh injects Cortex as an MCP server named "mesh-cortex" (tool names
// mcp__mesh-cortex__*). The PostToolUse presence matcher must keep matching
// them — narrowing it to mcp__cortex__ would silently kill presence beacons
// for every Mesh-spawned agent.
describe("hooks.json matchers", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const postMatchers: string[] = hooks.hooks.PostToolUse.map((h: { matcher: string }) => h.matcher);

  test("presence matcher covers mesh-cortex tool names", () => {
    const mcpMatcher = postMatchers.find((m) => m.includes("cortex"));
    expect(mcpMatcher).toBeDefined();
    expect(new RegExp(`^(${mcpMatcher})$`).test("mcp__mesh-cortex__search_graph")).toBe(true);
    expect(new RegExp(`^(${mcpMatcher})$`).test("mcp__cortex__decision")).toBe(true);
  });
});
