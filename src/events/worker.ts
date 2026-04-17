import { parentPort } from 'node:worker_threads';
import { EventPersister } from './worker/persister.js';
import { deriveMutations } from './worker/mutation-deriver.js';
import { GitWatcher } from './worker/git-watcher.js';
import type { Event, WireNode } from './types.js';

/**
 * Messages main thread → worker.
 *
 * `init` must be first; the worker does not process events until initialized.
 * `snapshot_update` replaces the node lookup (e.g., after another client
 * mutates the graph via `/api/graph` and we need a fresh snapshot). It may
 * optionally carry an updated `governed_files` map (source-id lists keyed by
 * repo-relative path) which the GitWatcher uses to populate commit
 * `decision_links`.
 *
 * If `repo_path` is supplied on `init`, the worker starts a `GitWatcher`
 * rooted at that path and feeds every new commit through the same
 * persist + derive + broadcast pipeline that bus events use. If omitted,
 * no watcher is started (e.g., in tests that only exercise events).
 */
type InMsg =
  | {
      type: 'init';
      events_db_path: string;
      project_id: string;
      nodes: WireNode[];
      repo_path?: string;
      governed_files?: Record<string, string[]>;
    }
  | { type: 'event'; event: Event }
  | {
      type: 'snapshot_update';
      nodes: WireNode[];
      governed_files?: Record<string, string[]>;
    }
  | { type: 'shutdown' };

/**
 * Messages worker → main thread.
 *
 * `ready` after init succeeds. `broadcast` carries the bundle for WS fan-out.
 * `error` wraps any internal failure; main decides whether to restart.
 */
type OutMsg =
  | { type: 'ready' }
  | {
      type: 'broadcast';
      bundle: { events: Event[]; mutations: ReturnType<typeof deriveMutations> };
    }
  | { type: 'error'; message: string };

if (!parentPort) {
  throw new Error('worker.ts must run as a worker_thread');
}

let persister: EventPersister | null = null;
let nodeMap: Map<string, WireNode> = new Map();
let gitWatcher: GitWatcher | null = null;
const lookup = (id: string) => nodeMap.get(id);

/**
 * Shared pipeline entry point: persist the event, derive mutations, post the
 * bundle to main for WS fan-out. Used by both incoming `event` messages and
 * the GitWatcher's `emit` callback.
 */
function processEvent(event: Event): void {
  if (!persister) throw new Error('worker not initialized');
  persister.insert(event);
  const mutations = deriveMutations(event, lookup);
  post({ type: 'broadcast', bundle: { events: [event], mutations } });
}

parentPort.on('message', (msg: InMsg) => {
  try {
    switch (msg.type) {
      case 'init': {
        persister = new EventPersister(msg.events_db_path);
        nodeMap = new Map(msg.nodes.map((n) => [n.id, n]));

        if (msg.repo_path) {
          gitWatcher = new GitWatcher({
            repoPath: msg.repo_path,
            persister,
            projectId: msg.project_id,
            governedFiles: new Map(Object.entries(msg.governed_files ?? {})),
            emit: (e) => processEvent(e),
          });
          gitWatcher
            .start()
            .catch((err) => post({ type: 'error', message: String(err) }));
        }

        post({ type: 'ready' });
        break;
      }

      case 'snapshot_update':
        nodeMap = new Map(msg.nodes.map((n) => [n.id, n]));
        if (gitWatcher && msg.governed_files) {
          gitWatcher.updateGovernedFiles(new Map(Object.entries(msg.governed_files)));
        }
        break;

      case 'event':
        processEvent(msg.event);
        break;

      case 'shutdown':
        gitWatcher?.stop().catch(() => {
          /* best-effort teardown */
        });
        persister?.close();
        process.exit(0);
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
});

function post(msg: OutMsg): void {
  parentPort!.postMessage(msg);
}
