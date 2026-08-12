import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { DecisionService } from "../../src/decisions/service.js";
import { recordReconciliationAction } from "../../src/mcp-server/tools/reconciliation-tools.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

/** A git root with a real committed file, so `governedRefs` has something to
 *  hash — a decision with zero GOVERNS links is rejected as non-reconcilable. */
function repoWithGovernedFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-reconc-")));
  execSync(`git init -q "${root}"`);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  execSync(`git -C "${root}" add .`);
  execSync(`git -C "${root}" commit -q --no-gpg-sign -m seed`);
  mkdirSync(join(root, ".cortex"));
  writeFileSync(join(root, ".cortex", "db"), "");
  cleanup.push(root);
  return root;
}

function setup() {
  const root = repoWithGovernedFile();
  const ctx = new RepoContextResolver({ poolCapacity: 4 }).resolve(root);
  const service = new DecisionService({
    db: ctx.decisionsDb,
    decisions: ctx.decisionsRepo,
    links: ctx.decisionLinksRepo,
  });
  return { ctx, service };
}

describe("decision reconcile — ref parity", () => {
  it("accepts the seq form and records the verdict", async () => {
    const { ctx, service } = setup();
    const created = service.create({ title: "t", rationale: "r", governs: ["a.ts"] });

    const result = await recordReconciliationAction(ctx, {
      decision_id: "D-1",
      verdict: "match",
    });

    expect(result.content[0].text).not.toMatch(/^No results:/);
    expect(service.getWithRefs(created.id)?.reconciliation_verdict).toBe("match");
  });

  it("reports the canonical id in its response, not the input ref", async () => {
    const { ctx, service } = setup();
    const created = service.create({ title: "t", rationale: "r", governs: ["a.ts"] });

    const result = await recordReconciliationAction(ctx, {
      decision_id: "D-1",
      verdict: "match",
    });

    expect(JSON.parse(result.content[0].text).decision_id).toBe(created.id);
  });

  it("still reports no results for a genuinely unknown ref", async () => {
    const { ctx } = setup();

    const result = await recordReconciliationAction(ctx, {
      decision_id: "D-404",
      verdict: "match",
    });
    expect(result.content[0].text).toMatch(/^No results:/);
  });
});
