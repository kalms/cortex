import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWatcher } from '../../src/events/worker/git-watcher.js';
import { EventPersister } from '../../src/events/worker/persister.js';
import type { Event } from '../../src/events/types.js';

let tmp: string;
let watcher: GitWatcher | null = null;
let persister: EventPersister | null = null;

afterEach(async () => {
  await watcher?.stop();
  persister?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function initRepo(): string {
  tmp = mkdtempSync(join(tmpdir(), 'cortex-git-'));
  execSync('git init -q -b main', { cwd: tmp });
  execSync('git config user.email test@test', { cwd: tmp });
  execSync('git config user.name TestUser', { cwd: tmp });
  writeFileSync(join(tmp, 'README.md'), 'init');
  execSync('git add . && git commit -q -m "initial"', { cwd: tmp });
  return tmp;
}

describe('GitWatcher', () => {
  it('emits a commit event when a new commit lands', async () => {
    const repo = initRepo();
    persister = new EventPersister(':memory:');
    const events: Event[] = [];
    watcher = new GitWatcher({
      repoPath: repo,
      persister,
      projectId: 'test',
      governedFiles: new Map(), // nothing governed yet
      emit: (e) => events.push(e),
    });
    await watcher.start();

    // Make a commit.
    writeFileSync(join(repo, 'new.ts'), 'export {}');
    execSync('git add . && git commit -q -m "feat: add new.ts"', { cwd: repo });

    // Trigger scan directly (deterministic — avoids relying on chokidar FSEvents timing).
    await watcher.scan();

    const commit = events.find((e) => e.kind === 'commit') as Extract<Event, { kind: 'commit' }>;
    expect(commit).toBeDefined();
    expect(commit.payload.message).toBe('feat: add new.ts');
    expect(commit.payload.files.map((f) => f.path)).toContain('new.ts');
    expect(commit.actor).toBe('TestUser');
  });

  it('computes decision_links from governed files', async () => {
    const repo = initRepo();
    persister = new EventPersister(':memory:');
    const events: Event[] = [];
    watcher = new GitWatcher({
      repoPath: repo,
      persister,
      projectId: 'test',
      // 'new.ts' is governed by decision 'd1'
      governedFiles: new Map([['new.ts', ['d1']]]),
      emit: (e) => events.push(e),
    });
    await watcher.start();

    writeFileSync(join(repo, 'new.ts'), 'export {}');
    execSync('git add . && git commit -q -m "touches governed"', { cwd: repo });

    // Trigger scan directly (deterministic).
    await watcher.scan();

    const commit = events.find((e) => e.kind === 'commit') as Extract<Event, { kind: 'commit' }>;
    expect(commit).toBeDefined();
    expect(commit.payload.decision_links).toEqual(['d1']);
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
