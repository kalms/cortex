import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { DecisionService } from "../../src/decisions/service.js";
import { getDecisionAction } from "../../src/mcp-server/tools/decision-tools.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

/** A real git root with an empty `.cortex/db`, which is all the resolver
 *  requires — GraphStore runs its own idempotent schema migration. */
function indexedGitRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-refparity-")));
  execSync(`git init -q "${root}"`);
  execSync(`git -C "${root}" commit -q --allow-empty -m init`);
  mkdirSync(join(root, ".cortex"));
  writeFileSync(join(root, ".cortex", "db"), "");
  cleanup.push(root);
  return root;
}

function serviceFor(ctx: {
  decisionsDb: import("better-sqlite3").Database;
  decisionsRepo: ConstructorParameters<typeof DecisionService>[0]["decisions"];
  decisionLinksRepo: ConstructorParameters<typeof DecisionService>[0]["links"];
}): DecisionService {
  return new DecisionService({
    db: ctx.decisionsDb,
    decisions: ctx.decisionsRepo,
    links: ctx.decisionLinksRepo,
  });
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

describe("decision get — ref parity", () => {
  it("returns byte-identical payloads for the canonical id and the seq form", async () => {
    const root = indexedGitRepo();
    const ctx = new RepoContextResolver({ poolCapacity: 4 }).resolve(root);
    const created = serviceFor(ctx).create({
      title: "parity",
      rationale: "r",
      governs: ["src/a.ts", "src/b.ts"],
    });

    const byCanonical = await getDecisionAction(ctx, { id: created.id });
    const bySeq = await getDecisionAction(ctx, { id: "D-1" });

    expect(text(bySeq)).toBe(text(byCanonical));
  });

  it("populates governs when addressed by the seq form", async () => {
    const root = indexedGitRepo();
    const ctx = new RepoContextResolver({ poolCapacity: 4 }).resolve(root);
    serviceFor(ctx).create({ title: "parity", rationale: "r", governs: ["src/a.ts"] });

    const payload = JSON.parse(text(await getDecisionAction(ctx, { id: "D-1" })));
    expect(payload.governs).toHaveLength(1);
    expect(payload.governs[0].target_ref).toBe("src/a.ts");
  });

  it("reports no results for an unknown ref in either form", async () => {
    const root = indexedGitRepo();
    const ctx = new RepoContextResolver({ poolCapacity: 4 }).resolve(root);

    expect(text(await getDecisionAction(ctx, { id: "D-404" }))).toMatch(/^No results:/);
    expect(text(await getDecisionAction(ctx, { id: "D-zzzz" }))).toMatch(/^No results:/);
  });
});
