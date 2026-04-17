import type { Event } from './types.js';

/**
 * Listener callback invoked once per emitted event.
 *
 * Must not throw — if it does, the bus logs to stderr and continues
 * dispatching to remaining listeners. Callers MUST NOT depend on a throw
 * aborting the emit; that would give earlier-registered listeners unfair
 * veto power over later ones.
 */
export type EventListener = (event: Event) => void;

/**
 * In-process event bus for the main thread.
 *
 * This is the facade the `DecisionService` talks to. The worker bridge
 * (added in `src/index.ts`) registers a listener that forwards events to
 * the worker thread via MessagePort. Tests can register a spy listener and
 * skip the worker entirely.
 *
 * Intentionally simple — no priorities, no async listeners, no backpressure.
 * If a listener needs async work, it should spawn it and return immediately.
 */
export class EventBus {
  private listeners = new Set<EventListener>();

  onEvent(listener: EventListener): void {
    this.listeners.add(listener);
  }

  offEvent(listener: EventListener): void {
    this.listeners.delete(listener);
  }

  emit(event: Event): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        process.stderr.write(`[EventBus] listener threw: ${(err as Error).message}\n`);
      }
    }
  }
}
