// tests/frame-extraction/indexer.test.ts
import { describe, it, expect } from "vitest";
import { parseEnvelope } from "../../scripts/frame-extraction/indexer.js";

describe("parseEnvelope", () => {
  it("returns ok=true with parsed payload on success", () => {
    const raw = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ project: "x", status: "indexed", nodes: 10 }) }],
    });
    const result = parseEnvelope<{ project: string; status: string; nodes: number }>(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.nodes).toBe(10);
      expect(result.data.status).toBe("indexed");
    }
  });

  it("returns ok=false with phase + message on error envelope", () => {
    const raw = JSON.stringify({
      content: [{
        type: "text",
        text: JSON.stringify({
          project: "p", status: "error",
          error_phase: "discover",
          error: "discovery failed (rc=-1)",
        }),
      }],
      isError: true,
    });
    const result = parseEnvelope(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_phase).toBe("discover");
      expect(result.error).toMatch(/discovery failed/);
    }
  });

  it("ok=false with phase=unknown on malformed envelope", () => {
    const result = parseEnvelope("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_phase).toBe("envelope_parse");
  });
});
