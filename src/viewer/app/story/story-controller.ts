// src/viewer/app/story/story-controller.ts
/** Story playback controller — open/page/advance/close semantics.
 *  `deps` is the injection seam: `fetchStory` for network, `engine()` for
 *  the live canvas engine instance (indirected through a getter so callers
 *  always see the current engineRef, not a stale one captured at import time). */

import { fetchStory } from "../api";
import { engineRef } from "../CanvasHost";
import { useUiStore } from "../ui-store";

export const deps = {
  fetchStory,
  engine: () => engineRef,
};

/** Fetch + enter story mode at `step` (default 1). No-op (console.warn) when
 *  the story 404s. Sets { story: { story, step, agentStep: null, following: true } }
 *  and applies the step. The ONLY entry points calling this: deep link, palette,
 *  live advance — never load. */
export async function openStory(id: string, step: number = 1): Promise<void> {
  const activeProject = useUiStore.getState().activeProject;
  const story = await deps.fetchStory(id, activeProject);
  if (!story) {
    console.warn(`story-controller: openStory(${id}) — story not found`);
    return;
  }
  const clamped = Math.max(1, Math.min(story.stepCount, step));
  useUiStore.getState().set({ story: { story, step: clamped, agentStep: null, following: true } });
  applyCurrentStep();
}

/** Exit story mode: story → null, spotlight cleared (applySpotlight(null)). */
export function closeStory(): void {
  useUiStore.getState().set({ story: null });
  deps.engine()?.applySpotlight(null);
}

/** Manual paging (arrows/buttons). Clamps to [1, stepCount]. Sets
 *  following = (newStep === agentStep) — paging ONTO the agent's step resumes following. */
export function pageStory(delta: 1 | -1): void {
  const cur = useUiStore.getState().story;
  if (!cur) return;
  const step = Math.max(1, Math.min(cur.story.stepCount, cur.step + delta));
  if (step === cur.step) return;
  useUiStore.getState().set({ story: { ...cur, step, following: step === cur.agentStep } });
  applyCurrentStep();
}

/** "agent is on step N →" chip click: jump to agentStep, following = true. */
export function syncToAgent(): void {
  const cur = useUiStore.getState().story;
  if (!cur || cur.agentStep == null) return;
  useUiStore.getState().set({ story: { ...cur, step: cur.agentStep, following: true } });
  applyCurrentStep();
}

/** Live show.advance for story `storyId`. Story open+same id: set agentStep;
 *  move step too only when following. Different/no story open: openStory(storyId, step)
 *  with agentStep=step (the arriving narration takes the stage — spec §5 entry point). */
export async function handleAdvanceEvent(storyId: string, step: number): Promise<void> {
  const cur = useUiStore.getState().story;
  if (cur && cur.story.id === storyId) {
    const clamped = Math.max(1, Math.min(cur.story.stepCount, step));
    if (cur.following) {
      useUiStore.getState().set({ story: { ...cur, step: clamped, agentStep: clamped, following: true } });
      applyCurrentStep();
    } else {
      useUiStore.getState().set({ story: { ...cur, agentStep: clamped } });
    }
    return;
  }
  // openStory clamps `step` against the freshly-fetched story's stepCount;
  // reuse its clamped `.step` rather than re-deriving from the raw arg.
  await openStory(storyId, step);
  const next = useUiStore.getState().story;
  // Guard on identity: openStory may 404 (next stays whatever was open before —
  // possibly a DIFFERENT story), so only stamp agentStep when the now-open
  // story really is the one this advance event was about.
  if (next && next.story.id === storyId) {
    useUiStore.getState().set({ story: { ...next, agentStep: next.step } });
  }
}

/** Drive the engine for the current step: applySpotlight({ refs, note: caption,
 *  emphasis_edges, fit: true }). Exported for project-switch re-entry. */
export function applyCurrentStep(): void {
  const cur = useUiStore.getState().story;
  if (!cur) return;
  const s = cur.story.steps[cur.step - 1];
  if (!s) return;
  deps.engine()?.applySpotlight({ refs: s.refs, note: s.caption, emphasis_edges: s.emphasis_edges, fit: true });
}
