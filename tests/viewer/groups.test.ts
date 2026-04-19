import { describe, it, expect } from 'vitest';
import {
  derivePathGroups,
  deriveTerritories,
  pathGroupId,
  territoryId,
  parentPathGroupId,
} from '../../src/viewer/shared/groups.js';

function makeNode(id: string, kind: string, file_path?: string, qualified_name?: string) {
  return { id, kind, name: id, file_path, qualified_name };
}

describe('groups', () => {
  describe('pathGroupId / territoryId', () => {
    it('pathGroupId is deterministic from dir path', () => {
      expect(pathGroupId('src/events/worker')).toBe('group:path:src/events/worker');
    });

    it('territoryId is deterministic from decision id', () => {
      expect(territoryId('dec-123')).toBe('group:decision:dec-123');
    });
  });

  describe('derivePathGroups', () => {
    it('groups files by their directory', () => {
      const nodes = [
        makeNode('a', 'file', 'src/events/worker/persister.ts'),
        makeNode('b', 'file', 'src/events/worker/git-watcher.ts'),
        makeNode('c', 'file', 'src/events/bus.ts'),
      ];
      const groups = derivePathGroups(nodes);
      const worker = groups.find((g) => g.id === 'group:path:src/events/worker');
      expect(worker).toBeDefined();
      expect(worker!.members.sort()).toEqual(['a', 'b']);
      expect(worker!.memberCount).toBe(2);
    });

    it('collapses singleton directories up', () => {
      const nodes = [
        makeNode('a', 'file', 'src/foo/only.ts'),
        makeNode('b', 'file', 'src/bar/x.ts'),
        makeNode('c', 'file', 'src/bar/y.ts'),
      ];
      const groups = derivePathGroups(nodes);
      // src/foo has only 1 member — should not exist as a group
      expect(groups.find((g) => g.id === 'group:path:src/foo')).toBeUndefined();
      // src/bar has 2 — should exist
      expect(groups.find((g) => g.id === 'group:path:src/bar')).toBeDefined();
    });

    it('nests functions under their owning file (via qualified_name)', () => {
      const nodes = [
        makeNode('file1', 'file', 'src/a.ts'),
        makeNode('fn1', 'function', 'src/a.ts', 'src/a.ts::doThing'),
        makeNode('fn2', 'function', 'src/a.ts', 'src/a.ts::otherThing'),
      ];
      const groups = derivePathGroups(nodes);
      // The file node serves as the implicit group for its functions — but we still
      // produce an explicit group entry so the projection can treat it uniformly.
      const fileGroup = groups.find((g) => g.id === 'group:path:src/a.ts');
      expect(fileGroup).toBeDefined();
      expect(fileGroup!.members.sort()).toEqual(['fn1', 'fn2']);
      expect(fileGroup!.kind).toBe('file');
    });

    it('skips decisions — they are always top-level', () => {
      const nodes = [
        makeNode('dec', 'decision', undefined),
        makeNode('a', 'file', 'src/x.ts'),
        makeNode('b', 'file', 'src/y.ts'),
      ];
      const groups = derivePathGroups(nodes);
      // No group should list the decision as a member
      for (const g of groups) {
        expect(g.members).not.toContain('dec');
      }
    });

    it('is deterministic across runs', () => {
      const nodes = [
        makeNode('a', 'file', 'src/events/worker/persister.ts'),
        makeNode('b', 'file', 'src/events/worker/git-watcher.ts'),
      ];
      const g1 = derivePathGroups(nodes);
      const g2 = derivePathGroups(nodes);
      expect(g1).toEqual(g2);
    });
  });

  describe('parentPathGroupId', () => {
    it('returns the parent directory group id', () => {
      expect(parentPathGroupId('src/events/worker')).toBe('group:path:src/events');
      expect(parentPathGroupId('src/events')).toBe('group:path:src');
      expect(parentPathGroupId('src')).toBeNull();
    });
  });

  describe('deriveTerritories', () => {
    it('groups governed members by decision', () => {
      const nodes = [
        makeNode('d1', 'decision'),
        makeNode('f1', 'file', 'src/a.ts'),
        makeNode('f2', 'file', 'src/b.ts'),
      ];
      const edges = [
        { source_id: 'd1', target_id: 'f1', relation: 'GOVERNS' },
        { source_id: 'd1', target_id: 'f2', relation: 'GOVERNS' },
      ];
      const territories = deriveTerritories(nodes, edges);
      expect(territories).toHaveLength(1);
      expect(territories[0].id).toBe('group:decision:d1');
      expect(territories[0].members.sort()).toEqual(['f1', 'f2']);
    });

    it('ignores non-GOVERNS edges', () => {
      const nodes = [makeNode('d1', 'decision'), makeNode('f1', 'file', 'src/a.ts')];
      const edges = [{ source_id: 'd1', target_id: 'f1', relation: 'REFERENCES' }];
      const territories = deriveTerritories(nodes, edges);
      expect(territories).toHaveLength(0);
    });

    it('returns no territory for decisions with zero governance', () => {
      const nodes = [makeNode('d1', 'decision')];
      const edges: any[] = [];
      const territories = deriveTerritories(nodes, edges);
      expect(territories).toHaveLength(0);
    });
  });
});
