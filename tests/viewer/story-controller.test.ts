// tests/viewer/story-controller.test.ts
// Story playback controller — open/page/advance/close semantics.
// deps.fetchStory / deps.engine are the test seam (see story-controller.ts);
// useUiStore.story is reset per test since it's a shared module-level store.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUiStore } from "../../src/viewer/app/ui-store";
import {
  deps,
  openStory,
  closeStory,
  pageStory,
  syncToAgent,
  handleAdvanceEvent,
} from "../../src/viewer/app/story/story-controller";

function makeStory(id: string, stepCount: number) {
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    step_index: i + 1,
    caption: `Step ${i + 1}`,
    refs: [`ref-${i + 1}`],
    emphasis_edges: [[`a${i + 1}`, `b${i + 1}`]],
    layout_hint: null,
  }));
  return {
    id,
    seq: 1,
    title: `Story ${id}`,
    description: "",
    status: "active",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stepCount,
    steps,
  };
}

function fakeEngine() {
  const calls: any[] = [];
  return { applySpotlight: (cmd: any) => calls.push(cmd), calls };
}

describe("story-controller", () => {
  let engine: ReturnType<typeof fakeEngine>;
  const story3 = makeStory("s1", 3);

  beforeEach(() => {
    useUiStore.setState({ story: null });
    engine = fakeEngine();
    deps.engine = () => engine as any;
    deps.fetchStory = async (id: string) => (id === "s1" ? story3 : null);
  });

  it("openStory sets playback at step 1 and applies the spotlight for step 1", async () => {
    await openStory("s1");
    const s = useUiStore.getState().story;
    expect(s).not.toBeNull();
    expect(s!.step).toBe(1);
    expect(s!.agentStep).toBeNull();
    expect(s!.following).toBe(true);
    expect(s!.story).toBe(story3);
    expect(engine.calls).toEqual([
      { refs: ["ref-1"], note: "Step 1", emphasis_edges: [["a1", "b1"]], fit: true },
    ]);
  });

  it("openStory leaves state null and warns on 404", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await openStory("missing");
    expect(useUiStore.getState().story).toBeNull();
    expect(engine.calls).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("pageStory clamps at the lower bound (no-op, no re-apply)", async () => {
    await openStory("s1", 1);
    engine.calls.length = 0;
    pageStory(-1);
    expect(useUiStore.getState().story!.step).toBe(1);
    expect(engine.calls).toEqual([]);
  });

  it("pageStory clamps at the upper bound (no-op, no re-apply)", async () => {
    await openStory("s1", 3);
    engine.calls.length = 0;
    pageStory(1);
    expect(useUiStore.getState().story!.step).toBe(3);
    expect(engine.calls).toEqual([]);
  });

  it("pageStory moves within range and re-applies the spotlight", async () => {
    await openStory("s1", 2);
    engine.calls.length = 0;
    pageStory(1);
    const s = useUiStore.getState().story!;
    expect(s.step).toBe(3);
    expect(engine.calls).toEqual([
      { refs: ["ref-3"], note: "Step 3", emphasis_edges: [["a3", "b3"]], fit: true },
    ]);
  });

  it("advance while paged away updates agentStep only (following stays false, no re-apply)", async () => {
    await openStory("s1", 1);
    // establish agentStep via a first advance while following
    await handleAdvanceEvent("s1", 2);
    expect(useUiStore.getState().story!.step).toBe(2);
    expect(useUiStore.getState().story!.agentStep).toBe(2);
    // page away — following flips off since new step !== agentStep
    pageStory(-1);
    expect(useUiStore.getState().story!.step).toBe(1);
    expect(useUiStore.getState().story!.following).toBe(false);
    engine.calls.length = 0;
    // agent advances again while viewer is paged away
    await handleAdvanceEvent("s1", 3);
    const s = useUiStore.getState().story!;
    expect(s.agentStep).toBe(3);
    expect(s.step).toBe(1); // unchanged
    expect(s.following).toBe(false);
    expect(engine.calls).toEqual([]); // no re-apply since step didn't move
  });

  it("advance while following moves both step and agentStep, and re-applies", async () => {
    await openStory("s1", 1);
    engine.calls.length = 0;
    await handleAdvanceEvent("s1", 2);
    const s = useUiStore.getState().story!;
    expect(s.step).toBe(2);
    expect(s.agentStep).toBe(2);
    expect(s.following).toBe(true);
    expect(engine.calls).toEqual([
      { refs: ["ref-2"], note: "Step 2", emphasis_edges: [["a2", "b2"]], fit: true },
    ]);
  });

  it("pageStory onto the agent's step flips following back on", async () => {
    await openStory("s1", 1);
    await handleAdvanceEvent("s1", 3); // agentStep=3, following stays true, step->3
    pageStory(-1); // step 2, following false (2 !== 3)
    pageStory(-1); // step 1, still false
    expect(useUiStore.getState().story!.following).toBe(false);
    pageStory(1); // step 2
    expect(useUiStore.getState().story!.following).toBe(false);
    pageStory(1); // step 3 === agentStep -> following resumes
    const s = useUiStore.getState().story!;
    expect(s.step).toBe(3);
    expect(s.following).toBe(true);
  });

  it("syncToAgent jumps to agentStep and resumes following", async () => {
    await openStory("s1", 1);
    await handleAdvanceEvent("s1", 3); // step/agentStep -> 3, following true
    pageStory(-1);
    pageStory(-1); // step=1, following=false, agentStep still 3
    expect(useUiStore.getState().story!.following).toBe(false);
    engine.calls.length = 0;
    syncToAgent();
    const s = useUiStore.getState().story!;
    expect(s.step).toBe(3);
    expect(s.following).toBe(true);
    expect(engine.calls).toEqual([
      { refs: ["ref-3"], note: "Step 3", emphasis_edges: [["a3", "b3"]], fit: true },
    ]);
  });

  it("syncToAgent is a no-op when agentStep is null", async () => {
    await openStory("s1", 2);
    engine.calls.length = 0;
    syncToAgent();
    const s = useUiStore.getState().story!;
    expect(s.step).toBe(2);
    expect(engine.calls).toEqual([]);
  });

  it("handleAdvanceEvent opens the story when nothing is open", async () => {
    expect(useUiStore.getState().story).toBeNull();
    await handleAdvanceEvent("s1", 2);
    const s = useUiStore.getState().story!;
    expect(s).not.toBeNull();
    expect(s.step).toBe(2);
    expect(s.agentStep).toBe(2);
    expect(s.following).toBe(true);
    expect(engine.calls).toEqual([
      { refs: ["ref-2"], note: "Step 2", emphasis_edges: [["a2", "b2"]], fit: true },
    ]);
  });

  it("handleAdvanceEvent for a different, nonexistent story leaves the open story untouched", async () => {
    await openStory("s1", 1);
    await handleAdvanceEvent("s1", 2); // agentStep=2, following=true (baseline)
    const before = useUiStore.getState().story!;
    engine.calls.length = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleAdvanceEvent("s2", 5); // s2 404s via deps.fetchStory
    warn.mockRestore();
    const after = useUiStore.getState().story!;
    expect(after.story.id).toBe("s1");
    expect(after.step).toBe(before.step);
    expect(after.agentStep).toBe(before.agentStep); // must stay 2, not get stamped with s2's step 5
    expect(after.following).toBe(before.following);
    expect(engine.calls).toEqual([]);
  });

  it("openStory clamps an out-of-range step to stepCount", async () => {
    await openStory("s1", 99);
    const s = useUiStore.getState().story!;
    expect(s.step).toBe(3);
    expect(engine.calls).toEqual([
      { refs: ["ref-3"], note: "Step 3", emphasis_edges: [["a3", "b3"]], fit: true },
    ]);
  });

  it("closeStory nulls state and clears the spotlight", async () => {
    await openStory("s1", 1);
    engine.calls.length = 0;
    closeStory();
    expect(useUiStore.getState().story).toBeNull();
    expect(engine.calls).toEqual([null]);
  });
});
