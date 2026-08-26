import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type HarnessContext, callTool, makeIndexedRepoFixture } from "./harness.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";
import { execSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function makeCommittedRepoFixture(): string {
  const root = makeIndexedRepoFixture();
  writeFileSync(join(root, "committed.ts"), "export const x = 1;\n");
  execSync(`git -C "${root}" add .`, { stdio: "ignore" });
  execSync(`git -C "${root}" commit -q --no-gpg-sign -m seed`, { stdio: "ignore" });
  return root;
}

describe("todo provenance is visible on MCP reads", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("stamps basis_hash when a GOVERNS link is added to a todo later", async () => {
    const repo = makeCommittedRepoFixture();
    try {
      const proposed = await callTool(h, "todo", {
        repo_path: repo, action: "propose", summary: "gains governance later",
      });
      const id = JSON.parse(proposed.content[0].text).id as string;
      const basisOf = (): string | null => {
        const db = openDecisionsDb(resolveDecisionsDbPath(repo));
        try {
          return (db.prepare("SELECT basis_hash FROM todos WHERE id=?").get(id) as
            { basis_hash: string | null }).basis_hash;
        } finally { db.close(); }
      };
      expect(basisOf()).toBeNull();

      await callTool(h, "todo", {
        repo_path: repo, action: "link", id, target: "committed.ts", relation: "GOVERNS",
      });
      expect(basisOf()).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Committed fixture deliberately: on a commit-less repo a real value and
  // NULL are indistinguishable, so this would pass against a deleted mapper.
  it("returns the real origin branch from todo get and list", async () => {
    const repo = makeCommittedRepoFixture();
    try {
      const proposed = await callTool(h, "todo", {
        repo_path: repo, action: "propose", summary: "visible provenance todo",
      });
      const id = JSON.parse(proposed.content[0].text).id as string;
      const realBranch = execSync(`git -C "${repo}" branch --show-current`).toString().trim();

      const got = JSON.parse((await callTool(h, "todo", { repo_path: repo, action: "get", id })).content[0].text);
      expect(got.origin_branch).toBe(realBranch);

      const listed = JSON.parse((await callTool(h, "todo", { repo_path: repo, action: "list" })).content[0].text);
      const rows = Array.isArray(listed) ? listed : listed.todos;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.find((t: { id: string }) => t.id === id).origin_branch).toBe(realBranch);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

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

describe("todo tool last-touched provenance", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("keeps origin immutable across an update", async () => {
    const created = await callTool(h, "todo", { action: "propose", summary: "immutable origin" });
    const id = JSON.parse(created.content[0].text).id as string;
    const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
    try {
      const before = db.prepare("SELECT origin_branch, origin_commit FROM todos WHERE id=?").get(id);
      await callTool(h, "todo", { action: "update", id, summary: "changed" });
      const after = db.prepare("SELECT origin_branch, origin_commit FROM todos WHERE id=?").get(id);
      expect(after).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("bumps updated_at when a link is added (closes the pre-existing addLink gap)", async () => {
    const created = await callTool(h, "todo", { action: "propose", summary: "link bumps updated_at" });
    const id = JSON.parse(created.content[0].text).id as string;
    const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
    try {
      const before = db.prepare("SELECT updated_at FROM todos WHERE id=?").get(id) as { updated_at: string };
      await new Promise((r) => setTimeout(r, 5));
      await callTool(h, "todo", { action: "link", id, target: "src/link-bump.ts", relation: "GOVERNS" });
      const after = db.prepare("SELECT updated_at FROM todos WHERE id=?").get(id) as { updated_at: string };
      expect(after.updated_at).not.toBe(before.updated_at);
    } finally {
      db.close();
    }
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
