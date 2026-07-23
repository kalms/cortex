import { describe, it, expect } from 'vitest';
import { deriveMutations } from '../../src/events/worker/mutation-deriver.js';
import type { Event } from '../../src/events/types.js';

describe('show.focus', () => {
  it('derives zero graph mutations', () => {
    const ev: Event = {
      id: '01J00000000000000000000000', kind: 'show.focus', actor: 'claude',
      created_at: 1721800000000, project_id: 'cortex',
      payload: { refs: ['src/decisions/repository.ts', 'D-zwrt'], note: 'storage walk' },
    };
    expect(deriveMutations(ev, () => undefined)).toEqual([]);
  });
});
