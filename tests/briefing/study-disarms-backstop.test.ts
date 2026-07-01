import { vi, describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachBriefing } from "../../src/mcp-server/briefing-attach.js";
import { composeBriefing } from "../../src/briefing/compose.js";
import { wasBriefed } from "../../src/briefing/ledger.js";

// Real ledger (NOT mocked) — proves the study→edit join end to end at the TS layer:
// study-time enrichment must record the FILE path the hook keys on, not just the qn.
vi.mock("../../src/briefing/compose.js", () => ({ composeBriefing: vi.fn() }));

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("study-time briefing disarms the edit backstop (real ledger)", () => {
  it("records both the qn and its file path so the file-keyed hook lookup hits", () => {
    dir = mkdtempSync(join(tmpdir(), "cortex-disarm-"));
    vi.mocked(composeBriefing).mockReturnValue({ gated: true, escalate: false, headline: "BRIEF" });
    const ctx = {
      repoPath: dir,
      store: { queryRaw: () => [{ name: "p" }] },
      decisionsRepo: {},
      decisionLinksRepo: {},
    } as any;
    const r = { content: [{ type: "text", text: "snippet" }] };

    attachBriefing(r, ctx, "src/foo.ts::bar");

    // The edit hook keys on the repo-relative FILE path; studying the symbol must disarm it.
    expect(wasBriefed(dir, "src/foo.ts")).toBe(true);
    // The studied qn is recorded too.
    expect(wasBriefed(dir, "src/foo.ts::bar")).toBe(true);
  });
});
