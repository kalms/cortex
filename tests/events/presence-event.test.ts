import { describe, it, expect } from 'vitest';
import { deriveMutations } from '../../src/events/worker/mutation-deriver.js';
import type { Event } from '../../src/events/types.js';

describe('presence.activity', () => {
  it('derives zero graph mutations', () => {
    const ev: Event = {
      id: '01J00000000000000000000000',
      kind: 'presence.activity',
      actor: 'claude',
      created_at: 1721700000000,
      project_id: 'cortex',
      payload: { session_id: 's-1', workspace: 'cortex', activity: 'studied', refs: ['src/index.ts'] },
    };
    expect(deriveMutations(ev, () => undefined)).toEqual([]);
  });
});
