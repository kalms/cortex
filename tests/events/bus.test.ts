import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import type { Event } from '../../src/events/types.js';

function sampleEvent(): Event {
  return {
    id: '01HXZ0000000000000000000AA',
    kind: 'decision.created',
    actor: 'claude',
    created_at: Date.now(),
    project_id: 'test',
    payload: {
      decision_id: 'd1',
      title: 't',
      rationale: 'r',
      governed_file_ids: [],
      tags: [],
    },
  } as Event;
}

describe('EventBus', () => {
  it('invokes registered listeners on emit', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.onEvent(listener);
    const e = sampleEvent();
    bus.emit(e);
    expect(listener).toHaveBeenCalledWith(e);
  });

  it('supports multiple listeners', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.onEvent(a);
    bus.onEvent(b);
    bus.emit(sampleEvent());
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('offEvent removes a listener', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.onEvent(listener);
    bus.offEvent(listener);
    bus.emit(sampleEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  it('listener exceptions do not prevent other listeners from firing', () => {
    const bus = new EventBus();
    const thrower = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    bus.onEvent(thrower);
    bus.onEvent(ok);
    bus.emit(sampleEvent());
    expect(ok).toHaveBeenCalledOnce();
  });
});
