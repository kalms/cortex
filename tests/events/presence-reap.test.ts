import { describe, it, expect, afterEach } from 'vitest';
import { EventPersister, PRESENCE_RETENTION_MS } from '../../src/events/worker/persister.js';
import type { Event } from '../../src/events/types.js';

const NOW = 1_721_700_000_000;

function makeEvent(overrides: Partial<Event> = {}): Event {
  let basePayload: any;
  if (overrides.kind === 'show.focus') {
    basePayload = { refs: [] };
  } else if (overrides.kind === 'show.advance') {
    basePayload = { story_id: 'S-test', step: 1 };
  } else {
    basePayload = {
      session_id: 's',
      workspace: 'w',
      activity: 'studied',
      refs: [],
    };
  }

  return {
    id: '01HXZ00000000000000000000A',
    kind: 'presence.activity',
    actor: 'claude',
    created_at: 1_700_000_000_000,
    project_id: 'cortex',
    payload: basePayload,
    ...overrides,
  } as Event;
}

describe('reapPresence', () => {
  let p: EventPersister;
  afterEach(() => p?.close());

  it('deletes only presence rows older than the retention window', () => {
    p = new EventPersister(':memory:');
    const prPayload = { pr_number: 1, title: 't', author: null, state: 'open', source: 'native' } as any;
    p.insert(makeEvent({ id: '01J0000000000000000000000A', kind: 'presence.activity', created_at: NOW - PRESENCE_RETENTION_MS - 1000 })); // old presence → reaped
    p.insert(makeEvent({ id: '01J0000000000000000000000B', kind: 'presence.activity', created_at: NOW - 1000 }));                          // fresh presence → kept
    p.insert(makeEvent({ id: '01J0000000000000000000000C', kind: 'pr.opened', created_at: NOW - PRESENCE_RETENTION_MS - 1000, payload: prPayload })); // old non-presence → kept
    expect(p.reapPresence(NOW)).toBe(1);
    const { events } = p.backfill({ limit: 10 });
    expect(events.map((e) => e.id).sort()).toEqual(['01J0000000000000000000000B', '01J0000000000000000000000C']);
  });

  it('reaps old show.focus events alongside presence', () => {
    p = new EventPersister(':memory:');
    p.insert(makeEvent({ id: '01J0000000000000000000001', kind: 'show.focus', created_at: NOW - PRESENCE_RETENTION_MS - 1000, payload: { refs: [] } })); // old show.focus → reaped
    p.insert(makeEvent({ id: '01J0000000000000000000002', kind: 'show.focus', created_at: NOW - 1000, payload: { refs: [] } }));                       // fresh show.focus → kept
    expect(p.reapPresence(NOW)).toBe(1);
    const { events } = p.backfill({ limit: 10 });
    expect(events.map((e) => e.id).sort()).toEqual(['01J0000000000000000000002']);
  });

  it('reaps old show.advance events alongside presence', () => {
    p = new EventPersister(':memory:');
    p.insert(makeEvent({ id: '01J0000000000000000003', kind: 'show.advance', created_at: NOW - PRESENCE_RETENTION_MS - 1000, payload: { story_id: 'S-test', step: 1 } })); // old show.advance → reaped
    p.insert(makeEvent({ id: '01J0000000000000000004', kind: 'show.advance', created_at: NOW - 1000, payload: { story_id: 'S-test', step: 2 } }));                       // fresh show.advance → kept
    expect(p.reapPresence(NOW)).toBe(1);
    const { events } = p.backfill({ limit: 10 });
    expect(events.map((e) => e.id).sort()).toEqual(['01J0000000000000000004']);
  });
});
