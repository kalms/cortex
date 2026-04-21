import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { PRService } from "../../src/prs/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../../src/events/types.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("PRService.open", () => {
  let dir: string;
  let store: GraphStore;
  let service: PRService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-open-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    service = new PRService(store, {
      bus: { emit: (e) => events.push(e) },
      default_actor: "tester",
      project_id: "test-project",
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("allocates monotonic numbers starting at 1", () => {
    const a = service.open({ title: "first", author: "mira" });
    const b = service.open({ title: "second", author: "kai" });
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
  });

  it("stores state='open' and source='native' by default, touches=[]", () => {
    const pr = service.open({ title: "x", author: "mira" });
    expect(pr.state).toBe("open");
    expect(pr.source).toBe("native");
    expect(pr.touches).toEqual([]);
  });

  it("emits pr.opened", () => {
    const pr = service.open({ title: "x", author: "mira" });
    const ev = events.find((e) => e.kind === "pr.opened");
    expect(ev).toBeDefined();
    expect((ev as any).payload.pr_number).toBe(pr.number);
    expect((ev as any).payload.title).toBe("x");
  });
});

describe("PRService.addTouch", () => {
  let dir: string;
  let store: GraphStore;
  let service: PRService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-touch-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    service = new PRService(store, {
      bus: { emit: (e) => events.push(e) },
      project_id: "t",
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends touch to inline array and emits pr.touched", () => {
    const pr = service.open({ title: "x", author: "m" });
    service.addTouch({
      pr_number: pr.number,
      frame_id: "src/temporal",
      node_name: "timeline.ts",
      action: "added",
    });
    const refreshed = service.get(pr.number)!;
    expect(refreshed.touches).toEqual([
      { frame_id: "src/temporal", node_name: "timeline.ts", action: "added" },
    ]);
    const ev = events.find((e) => e.kind === "pr.touched");
    expect(ev).toBeDefined();
  });

  it("is idempotent on duplicate touch", () => {
    const pr = service.open({ title: "x", author: "m" });
    service.addTouch({ pr_number: pr.number, frame_id: "a", node_name: "b", action: "added" });
    service.addTouch({ pr_number: pr.number, frame_id: "a", node_name: "b", action: "added" });
    expect(service.get(pr.number)!.touches.length).toBe(1);
  });

  it("throws on unknown PR number", () => {
    expect(() =>
      service.addTouch({ pr_number: 999, frame_id: "a", node_name: "b", action: "added" })
    ).toThrow();
  });
});

describe("PRService.merge", () => {
  let dir: string;
  let store: GraphStore;
  let prs: PRService;
  let decisions: DecisionService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-merge-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    const bus = { emit: (e: Event) => events.push(e) };
    decisions = new DecisionService(store, { bus });
    prs = new PRService(store, { bus, decisions });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ratifies introduced proposed decisions on merge", () => {
    const pr = prs.open({ title: "add temporal", author: "mira", introduces_frame: "src/temporal" });
    const prop = decisions.propose({
      title: "causal ordering",
      problem: "need order",
      resolution: "Lamport",
      rationale: "causality",
      pr_number: pr.number,
    });
    const result = prs.merge(pr.number);
    expect(result.ratified_decisions).toContain(prop.id);
    expect(decisions.get(prop.id)!.status).toBe("active");
    expect(prs.get(pr.number)!.state).toBe("merged");
  });

  it("emits pr.merged and decision.ratified", () => {
    const pr = prs.open({ title: "x", author: "m" });
    decisions.propose({
      title: "y",
      problem: "p",
      resolution: "r",
      rationale: "w",
      pr_number: pr.number,
    });
    prs.merge(pr.number);
    expect(events.find((e) => e.kind === "pr.merged")).toBeDefined();
    expect(events.find((e) => e.kind === "decision.ratified")).toBeDefined();
  });

  it("merging an already-merged PR throws", () => {
    const pr = prs.open({ title: "x", author: "m" });
    prs.merge(pr.number);
    expect(() => prs.merge(pr.number)).toThrow();
  });
});

describe("PRService.getWithRefs", () => {
  let dir: string;
  let store: GraphStore;
  let prs: PRService;
  let decisions: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-refs-"));
    store = new GraphStore(join(dir, "g.db"));
    const bus = { emit: () => {} };
    decisions = new DecisionService(store, { bus });
    prs = new PRService(store, { bus, decisions });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves introduces / implements groups", () => {
    const pr = prs.open({ title: "x", author: "m" });
    const intro = decisions.propose({
      title: "a", problem: "p", resolution: "r", rationale: "w", pr_number: pr.number,
    });
    const impl = decisions.create({ title: "b", description: "d", rationale: "r", problem: "p", resolution: "r" });
    store.createEdge({ source_id: prs.get(pr.number)!.id, target_id: impl.id, relation: "PR_IMPLEMENTS_DECISION", data: {} });

    const view = prs.getWithRefs(pr.number)!;
    expect(view.introduces_decisions).toContain(intro.id);
    expect(view.implements_decisions).toContain(impl.id);
  });
});
