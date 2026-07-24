import { describe, it, expect } from 'vitest';
import { PresencePostSchema, PresenceAckResponseSchema, CONTRACT_VERSION } from '../../src/mcp-server/api-schemas.js';

describe('presence contract', () => {
  const good = { session_id: 's-1', repo_path: '/Users/x/repo', workspace: 'repo', activity: 'studied', refs: ['src/a.ts'] };
  it('accepts a valid body', () => { expect(PresencePostSchema.safeParse(good).success).toBe(true); });
  it('rejects unknown activity', () => { expect(PresencePostSchema.safeParse({ ...good, activity: 'pondered' }).success).toBe(false); });
  it('rejects >50 refs', () => { expect(PresencePostSchema.safeParse({ ...good, refs: Array(51).fill('x') }).success).toBe(false); });
  it('rejects missing repo_path', () => { const { repo_path, ...rest } = good; expect(PresencePostSchema.safeParse(rest).success).toBe(false); });
  it('ack shape', () => { expect(PresenceAckResponseSchema.safeParse({ version: CONTRACT_VERSION, accepted: true }).success).toBe(true); });
});
