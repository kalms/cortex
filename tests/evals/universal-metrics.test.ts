import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runAssertion } from "../../evals/src/assertions/runner.js";
import { RATE_METRICS } from "../../evals/src/assertions/verdicts.js";
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

  // COUNT(DISTINCT file_path) treats NULL file_path values as indistinct from
  // each other (COUNT(DISTINCT NULL) contributes nothing), so two nodes that
  // share a qualified name but both lack a file_path are NOT counted as a
  // collision. Defensible — you cannot claim a cross-file collision without
  // file information — but worth pinning explicitly.
  it("does not count a shared qualified name when neither node has a file path", () => {
    store.createNode({ kind: "function", name: "x", qualified_name: "p.x" });
    store.createNode({ kind: "function", name: "x", qualified_name: "p.x" });
    expect(runAssertion(metric("qn_collisions"), { dbPath }).observed).toBe(0);
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

  it("reports a rate over zero rows as not measured, not as a number", () => {
    // An empty graph must not yield a flattering score: orphan_definition_rate
    // is lower_is_better, so a bogus low value would read as excellent and
    // could be adopted into a baseline as an improvement.
    expect(runAssertion(metric("call_attribution_rate"), { dbPath }).observed).toBeNull();
    expect(runAssertion(metric("orphan_definition_rate"), { dbPath }).observed).toBeNull();
  });

  it("still reports counts as zero on an empty graph", () => {
    expect(runAssertion(metric("file_sourced_calls"), { dbPath }).observed).toBe(0);
    expect(runAssertion(metric("qn_collisions"), { dbPath }).observed).toBe(0);
  });

  it("per_language_function_density reports callables per file, per language", () => {
    // 2 Go files, 3 callables -> 1.5 ; 1 Python file, 0 callables -> 0
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.a.__file__", file_path: "a.go" });
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.b.__file__", file_path: "b.go" });
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.c.__file__", file_path: "c.py" });
    store.createNode({ kind: "function", name: "f1", qualified_name: "p.a.f1", file_path: "a.go" });
    store.createNode({ kind: "function", name: "f2", qualified_name: "p.a.f2", file_path: "a.go" });
    store.createNode({ kind: "method", name: "m1", qualified_name: "p.b.K.m1", file_path: "b.go" });

    const r = runAssertion(metric("per_language_function_density"), { dbPath });
    expect(r.observed).toEqual({ go: 1.5, py: 0 });
  });

  it("per_language_function_density does not mint a key for a nested dotfile", () => {
    // "src/.gitignore" has no extension — node's path.extname() agrees. Treating
    // it as a language named "gitignore" would put a junk key in the baseline,
    // and these keys are a long-lived contract.
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.gi", file_path: "src/.gitignore" });
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.a", file_path: "src/a.ts" });
    store.createNode({ kind: "function", name: "f", qualified_name: "p.a.f", file_path: "src/a.ts" });

    const r = runAssertion(metric("per_language_function_density"), { dbPath });
    expect(Object.keys(r.observed as Record<string, number>)).toEqual(["ts"]);
  });

  it("per_language_function_density still reads a dotfile that has an extension", () => {
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.es", file_path: "src/.eslintrc.js" });
    const r = runAssertion(metric("per_language_function_density"), { dbPath });
    expect(Object.keys(r.observed as Record<string, number>)).toEqual(["js"]);
  });

  it("per_language_function_density ignores files with no extension", () => {
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.m.__file__", file_path: "Makefile" });
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.a.__file__", file_path: "a.rs" });
    store.createNode({ kind: "function", name: "f", qualified_name: "p.a.f", file_path: "a.rs" });

    const r = runAssertion(metric("per_language_function_density"), { dbPath });
    expect(r.observed).toEqual({ rs: 1 });
  });

  it("every RATE_METRICS name is a real universal assertion", () => {
    // RATE_METRICS is keyed by string, away from the assertions themselves.
    // Rename a metric in universal.ts and its epsilon silently drops from
    // 0.5pp to 0, so ordinary jitter would start reporting regressions.
    const names = new Set(UNIVERSAL_ASSERTIONS.map((a) => a.name));
    for (const m of RATE_METRICS) {
      expect(names.has(m), `RATE_METRICS names "${m}", which no assertion defines`).toBe(true);
    }
  });
});
