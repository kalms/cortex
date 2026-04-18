import { describe, it, expect } from 'vitest';
import { searchMatch } from '../../src/viewer/shared/search.js';

describe('searchMatch', () => {
  it('empty / falsy query matches every node', () => {
    expect(searchMatch({ name: 'foo' }, '')).toBe(true);
    expect(searchMatch({ name: 'bar' }, null)).toBe(true);
    expect(searchMatch({ name: 'baz' }, undefined)).toBe(true);
  });

  it('case-insensitive substring match on name', () => {
    expect(searchMatch({ name: 'AuthService' }, 'auth')).toBe(true);
    expect(searchMatch({ name: 'authservice' }, 'AUTH')).toBe(true);
    expect(searchMatch({ name: 'authservice' }, 'Thex')).toBe(false);
    expect(searchMatch({ name: 'Login' }, 'auth')).toBe(false);
  });

  it('matches on name only — ignores kind, file_path, data', () => {
    expect(searchMatch({ name: 'X', kind: 'auth' }, 'auth')).toBe(false);
    expect(searchMatch({ name: 'X', file_path: 'src/auth.ts' }, 'auth')).toBe(false);
    expect(searchMatch({ name: 'X', data: { rationale: 'about auth' } }, 'auth')).toBe(false);
  });

  it('tolerates missing name (no crash)', () => {
    expect(searchMatch({}, 'x')).toBe(false);
    expect(searchMatch({ name: null }, 'x')).toBe(false);
  });
});
