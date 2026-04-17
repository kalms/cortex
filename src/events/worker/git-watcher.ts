import chokidar, { FSWatcher } from 'chokidar';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from '../types.js';
import type { EventPersister } from './persister.js';
import { parseGitLogOutput, type ParsedCommit } from './git-log-parser.js';
import { newUlid } from '../ulid.js';

export interface GitWatcherOpts {
  repoPath: string;
  persister: EventPersister;
  projectId: string;
  /**
   * Map from file path (repo-relative) → decision ids governing that path.
   * Used to populate `decision_links` on each commit event.
   *
   * The worker keeps this map updated via `snapshot_update` messages from main.
   */
  governedFiles: Map<string, string[]>;
  /** Called once per new commit. */
  emit: (event: Event) => void;
}

const LAST_SEEN_KEY = 'git.last_seen_head';

/**
 * Watches a git repo for new commits on HEAD and emits `commit` events.
 *
 * Watch target: `<repo>/.git/logs/HEAD` — append-only on every ref update to HEAD.
 * On change: rev-parse current HEAD, compare to last-seen (stored in events.db
 * meta table), walk the diff with `git log <last>..HEAD`, emit one event per
 * new commit.
 *
 * Graceful degradation: if the repo is not a git repo, the watcher logs once
 * and stays idle. If `git log` fails, the watcher logs and retries on next fs
 * event — it does not crash the worker.
 */
export class GitWatcher {
  private fsw: FSWatcher | null = null;
  private busy = false;

  constructor(private opts: GitWatcherOpts) {}

  async start(): Promise<void> {
    const logHead = join(this.opts.repoPath, '.git', 'logs', 'HEAD');
    if (!existsSync(logHead)) {
      process.stderr.write(`[GitWatcher] no .git/logs/HEAD at ${this.opts.repoPath}; idle\n`);
      return;
    }

    // On start, record current HEAD if we don't have one yet (no historical emit).
    if (!this.opts.persister.getMeta(LAST_SEEN_KEY)) {
      try {
        const head = execSync('git rev-parse HEAD', { cwd: this.opts.repoPath }).toString().trim();
        this.opts.persister.setMeta(LAST_SEEN_KEY, head);
      } catch {
        // empty repo; stay idle
      }
    }

    this.fsw = chokidar.watch(logHead, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.fsw.on('change', () => this.scan());
    this.fsw.on('add', () => this.scan());
  }

  async stop(): Promise<void> {
    if (this.fsw) {
      await this.fsw.close();
      this.fsw = null;
    }
  }

  /** Exposed for tests: scan without waiting for a watcher event. */
  async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const head = execSync('git rev-parse HEAD', { cwd: this.opts.repoPath }).toString().trim();
      const lastSeen = this.opts.persister.getMeta(LAST_SEEN_KEY) ?? '';
      if (head === lastSeen) return;

      const range = lastSeen ? `${lastSeen}..${head}` : head;
      let output: string;
      try {
        output = execSync(
          `git log ${range} --format=%H%x00%s%x00%an%x00%at --name-status`,
          { cwd: this.opts.repoPath },
        ).toString();
      } catch {
        // Descendant check fail (checkout backward) — update last-seen silently.
        this.opts.persister.setMeta(LAST_SEEN_KEY, head);
        return;
      }

      // git inserts a blank line between the --format header line and the
      // --name-status file list. Strip those spurious blanks so parseGitLogOutput
      // doesn't terminate the commit before seeing the file list.
      output = stripPostHeaderBlanks(output);

      const commits = parseGitLogOutput(output).reverse(); // oldest first for chronological emission
      for (const c of commits) {
        this.opts.emit(this.commitToEvent(c));
      }
      this.opts.persister.setMeta(LAST_SEEN_KEY, head);
    } catch (err) {
      process.stderr.write(`[GitWatcher] scan failed: ${(err as Error).message}\n`);
    } finally {
      this.busy = false;
    }
  }

  private commitToEvent(c: ParsedCommit): Event {
    const decision_links = new Set<string>();
    for (const f of c.files) {
      const ids = this.opts.governedFiles.get(f.path);
      if (ids) for (const id of ids) decision_links.add(id);
    }
    return {
      id: newUlid(),
      kind: 'commit',
      actor: c.author || 'unknown',
      created_at: c.timestamp * 1000,
      project_id: this.opts.projectId,
      payload: {
        hash: c.hash,
        message: c.message,
        files: c.files,
        decision_links: [...decision_links],
      },
    };
  }
}

/**
 * git log --format=... --name-status inserts a blank line between the format
 * header line and the name-status file list. parseGitLogOutput uses blank lines
 * as commit terminators, so those spurious blanks cause files to be lost.
 *
 * This function removes blank lines that immediately follow a NUL-containing
 * header line, normalising the output to the format the parser expects.
 */
function stripPostHeaderBlanks(raw: string): string {
  const lines = raw.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    if (lines[i].includes('\0') && i + 1 < lines.length && lines[i + 1] === '') {
      i++; // skip the blank line after the header
    }
  }
  return result.join('\n');
}
