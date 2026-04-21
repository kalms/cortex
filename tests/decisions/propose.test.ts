import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../../src/events/types.js";

describe("DecisionService.propose", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-prop-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    service = new DecisionService(store, {
      bus: { emit: (e: Event) => events.push(e) },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a decision with status=proposed", () => {
    const d = service.propose({
      title: "causal ordering",
      problem: "need temporal order",
      resolution: "Lamport + wall-clock tiebreaker",
      rationale: "causal consistency without clock sync",
    });
    expect(d.status).toBe("proposed");
    expect(service.get(d.id)?.status).toBe("proposed");
  });

  it("emits decision.proposed with pr_number null when no PR linked", () => {
    const d = service.propose({
      title: "causal ordering",
      problem: "x",
      resolution: "y",
      rationale: "z",
    });
    const ev = events.find((e) => e.kind === "decision.proposed");
    expect(ev).toBeDefined();
    expect((ev as any).payload.decision_id).toBe(d.id);
    expect((ev as any).payload.pr_number).toBeNull();
  });

  it("links decision to PR when pr_number provided", () => {
    // Pre-insert a pull_request node directly via store
    const prNode = store.createNode({
      kind: "pull_request",
      name: "feature x",
      data: { number: 512, state: "open", author: "mira" },
      tier: "personal",
    });
    const d = service.propose({
      title: "causal ordering",
      problem: "p",
      resolution: "r",
      rationale: "w",
      pr_number: 512,
    });
    // Edge must exist
    const edges = store.findEdges({ source_id: prNode.id, target_id: d.id });
    expect(edges.some((e) => e.relation === "PR_INTRODUCES_DECISION")).toBe(true);
    // Event payload should carry the number
    const ev = events.find((e) => e.kind === "decision.proposed") as any;
    expect(ev.payload.pr_number).toBe(512);
  });
});
