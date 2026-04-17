import { describe, it, expect, afterEach } from 'vitest';
import { GraphStore } from '../../src/graph/store.js';
import { DecisionService } from '../../src/decisions/service.js';
import { DecisionPromotion } from '../../src/decisions/promotion.js';
import { EventBus } from '../../src/events/bus.js';
import type { Event } from '../../src/events/types.js';

describe('DecisionPromotion event emission', () => {
  let store: GraphStore;
  afterEach(() => store?.close());

  it('emits decision.promoted on promote() with from_tier and to_tier', () => {
    store = new GraphStore(':memory:');
    const bus = new EventBus();
    const service = new DecisionService(store, { bus, project_id: 'test' });
    const promotion = new DecisionPromotion(store, { bus, project_id: 'test' });

    const d = service.create({
      title: 'Logging standard',
      description: 'desc',
      rationale: 'rationale',
    });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    promotion.promote(d.id, 'team');

    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event.kind).toBe('decision.promoted');
    if (event.kind === 'decision.promoted') {
      expect(event.payload.decision_id).toBe(d.id);
      expect(event.payload.from_tier).toBe('personal');
      expect(event.payload.to_tier).toBe('team');
    }
    expect(event.actor).toBe('claude');
    expect(event.project_id).toBe('test');
  });

  it('no bus is allowed — promote() still works', () => {
    store = new GraphStore(':memory:');
    const service = new DecisionService(store);
    const promotion = new DecisionPromotion(store); // no bus — backwards compatible

    const d = service.create({ title: 't', description: '', rationale: '' });
    expect(() => promotion.promote(d.id, 'team')).not.toThrow();
  });
});
