import { describe, it, expect, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, GraphMutation } from '../../src/events/types.js';

/**
 * Integration: GitWatcher wired inside the worker.
 *
 * Spawns the real worker via the test bootstrap, seeds a temp git repo,
 * sends `init` with `repo_path`, waits for `ready`, then makes a new
 * commit in the repo. Asserts the worker emits a `broadcast` bundle with
 * a `commit` event whose hash matches the commit we just made.
 *
 * Uses the snapshot_update message to nudge the worker's scan (the
 * GitWatcher normally scans on chokidar events, but those can be flaky
 * on macOS; we let the watcher run but also call scan directly for
 * deterministic timing).
 */

let worker: Worker | null = null;
let tmp: string = '';

afterEach(async () => {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-worker-git-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email test@test', { cwd: dir });
  execSync('git config user.name TestUser', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'init');
  execSync('git add . && git commit -q -m "initial"', { cwd: dir });
  return dir;
}

describe('worker + git wiring', () => {
  it('emits a commit broadcast when a new commit lands in the init repo', async () => {
    tmp = initRepo();

    worker = new Worker(
      new URL('./worker-bootstrap.mjs', import.meta.url),
      { execArgv: [] },
    );

    const broadcasts: { events: Event[]; mutations: GraphMutation[] }[] = [];
    worker.on('message', (msg) => {
      if (msg.type === 'broadcast') broadcasts.push(msg.bundle);
    });

    // Init with repo_path — the worker will start a GitWatcher rooted here.
    await new Promise<void>((resolve) => {
      const handler = (msg: { type: string }) => {
        if (msg.type === 'ready') {
          worker!.off('message', handler);
          resolve();
        }
      };
      worker!.on('message', handler);
      worker!.postMessage({
        type: 'init',
        events_db_path: ':memory:',
        project_id: 'test',
        nodes: [],
        repo_path: tmp,
        governed_files: {},
      });
    });

    // Make a second commit in the repo.
    writeFileSync(join(tmp, 'new.ts'), 'export {}');
    execSync('git add . && git commit -q -m "feat: add new.ts"', { cwd: tmp });
    const hash = execSync('git rev-parse HEAD', { cwd: tmp }).toString().trim();

    // Wait for chokidar to pick up .git/logs/HEAD and for the watcher to scan.
    // Poll up to ~3s for the broadcast to arrive.
    const deadline = Date.now() + 3000;
    let commitEvent: Extract<Event, { kind: 'commit' }> | undefined;
    while (Date.now() < deadline) {
      commitEvent = broadcasts
        .flatMap((b) => b.events)
        .find((e): e is Extract<Event, { kind: 'commit' }> => e.kind === 'commit');
      if (commitEvent) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(commitEvent).toBeDefined();
    expect(commitEvent!.payload.hash).toBe(hash);
    expect(commitEvent!.payload.message).toBe('feat: add new.ts');
  });
});
