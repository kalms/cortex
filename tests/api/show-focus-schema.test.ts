import { describe, it, expect } from 'vitest';
import { ShowFocusPostSchema, ShowFocusAckResponseSchema, CONTRACT_VERSION } from '../../src/mcp-server/api-schemas.js';

describe('show-focus contract', () => {
  const good = { repo_path: '/Users/x/repo', refs: ['src/a.ts'] };
  it('accepts a valid body', () => { expect(ShowFocusPostSchema.safeParse(good).success).toBe(true); });
  it('accepts empty refs (clear)', () => { expect(ShowFocusPostSchema.safeParse({ ...good, refs: [] }).success).toBe(true); });
  it('accepts optional note', () => { expect(ShowFocusPostSchema.safeParse({ ...good, note: 'focus on this area' }).success).toBe(true); });
  it('rejects >50 refs', () => { expect(ShowFocusPostSchema.safeParse({ ...good, refs: Array(51).fill('x') }).success).toBe(false); });
  it('rejects >2000 char note', () => { expect(ShowFocusPostSchema.safeParse({ ...good, note: 'x'.repeat(2001) }).success).toBe(false); });
  it('rejects missing repo_path', () => { const { repo_path, ...rest } = good; expect(ShowFocusPostSchema.safeParse(rest).success).toBe(false); });
  it('ack shape', () => { expect(ShowFocusAckResponseSchema.safeParse({ version: CONTRACT_VERSION, accepted: true }).success).toBe(true); });
});
