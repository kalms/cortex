import { parentPort } from 'node:worker_threads';
import { EventPersister } from './worker/persister.js';
import { deriveMutations } from './worker/mutation-deriver.js';
import type { Event, WireNode } from './types.js';

/**
 * Messages main thread → worker.
 *
 * `init` must be first; the worker does not process events until initialized.
 * `snapshot_update` replaces the node lookup (e.g., after another client
 * mutates the graph via `/api/graph` and we need a fresh snapshot).
 */
type InMsg =
  | {
      type: 'init';
      events_db_path: string;
      project_id: string;
      nodes: WireNode[];
    }
  | { type: 'event'; event: Event }
  | { type: 'snapshot_update'; nodes: WireNode[] }
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
const lookup = (id: string) => nodeMap.get(id);

parentPort.on('message', (msg: InMsg) => {
  try {
    switch (msg.type) {
      case 'init':
        persister = new EventPersister(msg.events_db_path);
        nodeMap = new Map(msg.nodes.map((n) => [n.id, n]));
        post({ type: 'ready' });
        break;

      case 'snapshot_update':
        nodeMap = new Map(msg.nodes.map((n) => [n.id, n]));
        break;

      case 'event': {
        if (!persister) throw new Error('worker not initialized');
        persister.insert(msg.event);
        const mutations = deriveMutations(msg.event, lookup);
        post({
          type: 'broadcast',
          bundle: { events: [msg.event], mutations },
        });
        break;
      }

      case 'shutdown':
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
