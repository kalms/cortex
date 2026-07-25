import { describe, it, expect } from 'vitest';
import { deriveMutations } from '../../src/events/worker/mutation-deriver.js';
import type { Event } from '../../src/events/types.js';

describe('show.advance', () => {
  it('show.advance derives zero mutations', () => {
    const e = { id: "01AAAAAAAAAAAAAAAAAAAAAAAA", kind: "show.advance", actor: "claude",
      created_at: Date.now(), project_id: "", payload: { story_id: "S-abcd", step: 2 } } as Event;
    expect(deriveMutations(e, () => undefined)).toEqual([]);
  });
});
