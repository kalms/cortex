import { describe, it, expect } from 'vitest';
import { searchMatch, findMatches } from '../../src/viewer/shared/search.js';

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

describe('findMatches', () => {
  it('returns empty array for empty query', () => {
    const nodes = [{ id: 'a', name: 'foo' }];
    expect(findMatches(nodes, '')).toEqual([]);
  });

  it('returns all nodes whose name contains query (case-insensitive)', () => {
    const nodes = [
      { id: 'a', name: 'Projection', x: 1, y: 2 },
      { id: 'b', name: 'camera' },
      { id: 'c', name: 'projector', x: 3, y: 4 },
    ];
    const matches = findMatches(nodes, 'proj');
    expect(matches.map(m => m.id)).toEqual(['a', 'c']);
    expect(matches[0].x).toBe(1);
    expect(matches[0].y).toBe(2);
  });

  it('preserves node order', () => {
    const nodes = [
      { id: 'z', name: 'alpha' },
      { id: 'a', name: 'alpha' },
    ];
    const matches = findMatches(nodes, 'alpha');
    expect(matches.map(m => m.id)).toEqual(['z', 'a']);
  });
});
