import { describe, it, expect } from 'vitest';
import { newUlid } from '../../src/events/ulid.js';

describe('newUlid', () => {
  it('produces 26-char Crockford base32 strings', () => {
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is monotonic across rapid calls within the same millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => newUlid());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
