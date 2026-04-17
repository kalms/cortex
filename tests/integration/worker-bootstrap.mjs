/**
 * Bootstrap wrapper for worker.ts in test environments.
 *
 * Registers tsx's ESM loader so that .js → .ts resolution works in the
 * worker thread (tsx's default IPC approach doesn't propagate into workers
 * on Node 23). Then delegates to the actual worker.ts.
 */
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve tsx relative to the project root
const tsxLoaderPath = resolve(
  __dirname,
  '../../node_modules/tsx/dist/esm/index.mjs',
);

const { port2 } = new MessageChannel();
register(pathToFileURL(tsxLoaderPath).href, {
  parentURL: import.meta.url,
  data: { port: port2 },
  transferList: [port2],
});

// Delegate to the actual worker
await import(new URL('../../src/events/worker.ts', import.meta.url).href);
