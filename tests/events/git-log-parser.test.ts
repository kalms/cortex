import { describe, it, expect } from 'vitest';
import { parseGitLogOutput } from '../../src/events/worker/git-log-parser.js';

// Format: %H\x00%s\x00%an\x00%at   then --name-status lines
const NUL = '\x00';
const SAMPLE_OUTPUT = [
  `abc1234${NUL}fix: restart watcher on .git move${NUL}Rasmus${NUL}1700000000`,
  'M\tsrc/events/git-watcher.ts',
  'M\tsrc/events/meta.ts',
  'A\ttest/git-watcher.test.ts',
  '',
  `def5678${NUL}feat: events schema${NUL}Rasmus${NUL}1699999000`,
  'A\tsrc/events/schema.sql',
  'A\tsrc/events/store.ts',
  '',
].join('\n');

describe('parseGitLogOutput', () => {
  it('parses multiple commits with name-status', () => {
    const commits = parseGitLogOutput(SAMPLE_OUTPUT);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: 'abc1234',
      message: 'fix: restart watcher on .git move',
      author: 'Rasmus',
      timestamp: 1700000000,
      files: [
        { path: 'src/events/git-watcher.ts', status: 'M' },
        { path: 'src/events/meta.ts', status: 'M' },
        { path: 'test/git-watcher.test.ts', status: 'A' },
      ],
    });
    expect(commits[1].hash).toBe('def5678');
    expect(commits[1].files).toHaveLength(2);
  });

  it('handles a commit with no file changes', () => {
    const out = `empty00${NUL}empty commit${NUL}R${NUL}1700000000\n\n`;
    const commits = parseGitLogOutput(out);
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(parseGitLogOutput('')).toEqual([]);
    expect(parseGitLogOutput('\n\n\n')).toEqual([]);
  });

  it('maps rename (R) and copy (C) statuses preserving the target path', () => {
    const out = [
      `h1${NUL}rename${NUL}R${NUL}1700000000`,
      'R100\tsrc/old.ts\tsrc/new.ts',
      '',
    ].join('\n');
    const commits = parseGitLogOutput(out);
    expect(commits[0].files).toEqual([{ path: 'src/new.ts', status: 'R' }]);
  });
});
