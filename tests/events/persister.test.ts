import { describe, it, expect, afterEach } from 'vitest';
import { EventPersister } from '../../src/events/worker/persister.js';
import type { Event } from '../../src/events/types.js';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: '01HXZ00000000000000000000A',
    kind: 'decision.created',
    actor: 'claude',
    created_at: 1_700_000_000_000,
    project_id: 'cortex',
    payload: {
      decision_id: 'd1',
      title: 't',
      rationale: 'r',
      governed_file_ids: [],
      tags: [],
    },
    ...overrides,
  } as Event;
}

describe('EventPersister', () => {
  let persister: EventPersister;
  afterEach(() => persister?.close());

  it('inserts an event and reads it back', () => {
    persister = new EventPersister(':memory:');
    const e = makeEvent();
    persister.insert(e);
    const page = persister.backfill({ limit: 10 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0].id).toBe(e.id);
    expect(page.events[0].kind).toBe('decision.created');
    expect(page.has_more).toBe(false);
  });

  it('returns events newest-first; has_more when more remain', () => {
    persister = new EventPersister(':memory:');
    for (let i = 0; i < 5; i++) {
      persister.insert(
        makeEvent({
          id: `01HXZ0000000000000000000${i}0`,
          created_at: 1_700_000_000_000 + i,
        }),
      );
    }
    const page = persister.backfill({ limit: 3 });
    expect(page.events.map((e) => e.id)).toEqual([
      '01HXZ000000000000000000040',
      '01HXZ000000000000000000030',
      '01HXZ000000000000000000020',
    ]);
    expect(page.has_more).toBe(true);
  });

  it('paginates with before_id', () => {
    persister = new EventPersister(':memory:');
    for (let i = 0; i < 5; i++) {
      persister.insert(
        makeEvent({
          id: `01HXZ0000000000000000000${i}0`,
          created_at: 1_700_000_000_000 + i,
        }),
      );
    }
    const page = persister.backfill({
      before_id: '01HXZ000000000000000000020',
      limit: 10,
    });
    expect(page.events.map((e) => e.id)).toEqual([
      '01HXZ000000000000000000010',
      '01HXZ000000000000000000000',
    ]);
  });

  it('get/set meta roundtrips', () => {
    persister = new EventPersister(':memory:');
    persister.setMeta('last_seen_head', 'abc123');
    expect(persister.getMeta('last_seen_head')).toBe('abc123');
    expect(persister.getMeta('missing')).toBeUndefined();
  });
});
