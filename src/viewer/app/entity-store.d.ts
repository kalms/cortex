// Type declarations for entity-store.js — the viewer's normalized reactive
// store for projected entities (decisions, todos). See entity-store.js for
// the runtime implementation and docs/architecture/viewer-sync-engine.md for
// the sync protocol this backs.

export interface EntityStoreState {
  decisions: Record<string, any>;
  todos: Record<string, any>;
  cursor: string | null;
}

export interface EntityStore {
  state: EntityStoreState;
  readonly hydrated: boolean;
  hydrate(input: { decisions?: Record<string, any>; todos?: Record<string, any>; cursor?: string | null }): void;
  apply(delta: any, opts?: { animate?: boolean }): void;
  setCursor(ulid: string): void;
  subscribe(fn: (changes: any[]) => void): () => void;
}

export function createStore(opts?: { schedule?: (fn: () => void) => void }): EntityStore;
