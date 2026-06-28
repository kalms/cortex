import { vi, describe, it, expect } from "vitest";
import { attachBriefing } from "../../src/mcp-server/briefing-attach.js";
import { composeBriefing } from "../../src/briefing/compose.js";

vi.mock("../../src/briefing/compose.js", () => ({ composeBriefing: vi.fn() }));

function fakeCtx() {
  return {
    repoPath: "/repo",
    store: { queryRaw: () => [{ name: "p" }] } as any,
    decisionsRepo: {} as any,
    decisionLinksRepo: {} as any,
  } as any;
}

describe("attachBriefing", () => {
  it("appends the headline to the first text block when gated", () => {
    vi.mocked(composeBriefing).mockReturnValue({ gated: true, escalate: false, headline: "BRIEF" });
    const r = { content: [{ type: "text", text: "snippet" }] };
    const out = attachBriefing(r, fakeCtx(), "src/foo.ts::bar");
    expect(out.content[0].text).toContain("snippet");
    expect(out.content[0].text).toContain("BRIEF");
  });
  it("returns unchanged when ungated", () => {
    vi.mocked(composeBriefing).mockReturnValue({ gated: false, escalate: false, headline: "" });
    const r = { content: [{ type: "text", text: "snippet" }] };
    const out = attachBriefing(r, fakeCtx(), "src/foo.ts::bar");
    expect(out.content[0].text).toBe("snippet");
  });
  it("returns unchanged when CORTEX_BRIEF=0", () => {
    vi.mocked(composeBriefing).mockReturnValue({ gated: true, escalate: false, headline: "BRIEF" });
    const prev = process.env.CORTEX_BRIEF;
    process.env.CORTEX_BRIEF = "0";
    const r = { content: [{ type: "text", text: "snippet" }] };
    const out = attachBriefing(r, fakeCtx(), "src/foo.ts::bar");
    expect(out.content[0].text).toBe("snippet");
    process.env.CORTEX_BRIEF = prev;
  });
});
