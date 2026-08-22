import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runAssertion } from "../../evals/src/assertions/runner.js";
import { UNIVERSAL_ASSERTIONS } from "../../evals/src/assertions/universal.js";

function metric(name: string) {
  const a = UNIVERSAL_ASSERTIONS.find((x) => x.name === name);
  if (!a) throw new Error(`no universal metric named ${name}`);
  return a;
}

describe("universal metrics", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-universal-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("file_sourced_calls counts CALLS edges sourced at a file node", () => {
    const f = store.createNode({ kind: "file", name: "__file__", qualified_name: "p.a.__file__", file_path: "a.ts" });
    const fn = store.createNode({ kind: "function", name: "caller", qualified_name: "p.a.caller", file_path: "a.ts" });
    const t = store.createNode({ kind: "function", name: "target", qualified_name: "p.b.target", file_path: "b.ts" });
    store.createEdge({ source_id: f.id, target_id: t.id, relation: "CALLS" });
    store.createEdge({ source_id: fn.id, target_id: t.id, relation: "CALLS" });

    const r = runAssertion(metric("file_sourced_calls"), { dbPath });
    expect(r.observed).toBe(1);
  });

  it("call_attribution_rate is the percentage of CALLS sourced at a callable", () => {
    const f = store.createNode({ kind: "file", name: "__file__", qualified_name: "p.a.__file__", file_path: "a.ts" });
    const fn = store.createNode({ kind: "function", name: "caller", qualified_name: "p.a.caller", file_path: "a.ts" });
    const m = store.createNode({ kind: "method", name: "m", qualified_name: "p.a.K.m", file_path: "a.ts" });
    const t = store.createNode({ kind: "function", name: "target", qualified_name: "p.b.target", file_path: "b.ts" });
    store.createEdge({ source_id: f.id, target_id: t.id, relation: "CALLS" });
    store.createEdge({ source_id: fn.id, target_id: t.id, relation: "CALLS" });
    store.createEdge({ source_id: m.id, target_id: t.id, relation: "CALLS" });

    const r = runAssertion(metric("call_attribution_rate"), { dbPath });
    expect(Number(r.observed)).toBeCloseTo(66.666, 2);
  });

  it("qn_collisions counts qualified names shared across differing files", () => {
    store.createNode({ kind: "function", name: "collideMe", qualified_name: "p.lib.collideMe", file_path: "lib.ts" });
    store.createNode({ kind: "function", name: "collideMe", qualified_name: "p.lib.collideMe", file_path: "lib/index.ts" });
    store.createNode({ kind: "function", name: "fine", qualified_name: "p.lib.fine", file_path: "lib.ts" });

    const r = runAssertion(metric("qn_collisions"), { dbPath });
    expect(r.observed).toBe(1);
  });

  it("qn_collisions ignores a repeated QN within one file", () => {
    store.createNode({ kind: "function", name: "dup", qualified_name: "p.a.dup", file_path: "a.ts" });
    store.createNode({ kind: "function", name: "dup", qualified_name: "p.a.dup", file_path: "a.ts" });

    const r = runAssertion(metric("qn_collisions"), { dbPath });
    expect(r.observed).toBe(0);
  });

  it("orphan_definition_rate is the percentage of definition nodes with no edges", () => {
    const a = store.createNode({ kind: "function", name: "wired", qualified_name: "p.a.wired", file_path: "a.ts" });
    const b = store.createNode({ kind: "function", name: "alsoWired", qualified_name: "p.a.also", file_path: "a.ts" });
    store.createNode({ kind: "function", name: "orphan", qualified_name: "p.a.orphan", file_path: "a.ts" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });

    const r = runAssertion(metric("orphan_definition_rate"), { dbPath });
    expect(Number(r.observed)).toBeCloseTo(33.333, 2);
  });

  it("orphan_definition_rate ignores variable nodes", () => {
    const a = store.createNode({ kind: "function", name: "wired", qualified_name: "p.a.wired", file_path: "a.ts" });
    const b = store.createNode({ kind: "function", name: "b", qualified_name: "p.a.b", file_path: "a.ts" });
    store.createEdge({ source_id: a.id, target_id: b.id, relation: "CALLS" });
    // 50 unwired variables must not move the metric.
    for (let i = 0; i < 50; i++) {
      store.createNode({ kind: "variable", name: `v${i}`, qualified_name: `p.a.v${i}`, file_path: "a.ts" });
    }

    const r = runAssertion(metric("orphan_definition_rate"), { dbPath });
    expect(Number(r.observed)).toBe(0);
  });
});
