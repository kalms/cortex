// src/viewer/app/story/story-controller.ts
/** Story playback controller — stubs only. Task 11 fills in the bodies.
 *  `deps` is the injection seam: `fetchStory` for network, `engine()` for
 *  the live canvas engine instance (indirected through a getter so callers
 *  always see the current engineRef, not a stale one captured at import time). */

import { fetchStory } from "../api";
import { engineRef } from "../CanvasHost";

export const deps = {
  fetchStory,
  engine: () => engineRef,
};

export function openStory(id: string, step: number = 1): Promise<void> {
  // Task 11
  return Promise.resolve();
}

export function closeStory(): void {
  // Task 11
}

export function pageStory(delta: number): void {
  // Task 11
}

export function syncToAgent(): void {
  // Task 11
}

export function handleAdvanceEvent(storyId: string, step: number): Promise<void> {
  // Task 11
  return Promise.resolve();
}

export function applyCurrentStep(): void {
  // Task 11
}
