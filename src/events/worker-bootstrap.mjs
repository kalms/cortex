/**
 * Bootstrap wrapper for worker.ts / worker.js spawned from the main process.
 *
 * Why this file exists: tsx's default IPC-based resolve hook (which maps
 * .js → .ts) does NOT propagate into worker_threads on Node 23+ because the
 * worker's tsx instance can't reach the parent's esbuild server — tsx uses
 * `process.ppid` and in a worker that points to the shell, not the tsx-
 * transformed main process. `execArgv: ['--import', 'tsx']` has the same
 * limitation.
 *
 * Solution: this .mjs loader registers tsx's ESM loader directly inside the
 * worker via `module.register()`, bypassing the IPC pipe. Then it imports the
 * worker entry point.
 *
 * In production (compiled JS), tsx is not installed as a runtime dep and the
 * register() call would throw. We guard with a try/catch so prod builds just
 * skip tsx registration and import the plain `.js` worker file directly.
 *
 * Pattern mirrors tests/integration/worker-bootstrap.mjs which was proven
 * working on Node 23 + tsx 4.x in Task 7.
 */
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try to register tsx. In dev (run via `tsx src/index.ts`), this resolves to
// the tsx loader in node_modules. In prod (node dist/events/worker-bootstrap.mjs),
// the file may not exist — swallow the error and proceed to the plain import.
try {
  // From src/events/worker-bootstrap.mjs: ../../node_modules/tsx/...
  // From dist/events/worker-bootstrap.mjs: ../../node_modules/tsx/...
  // Both layouts have node_modules at the same relative depth.
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
} catch {
  // tsx not available (production build) — proceed with plain .js import.
}

// Import the worker. In dev, the .js specifier resolves to worker.ts via tsx.
// In prod, it resolves to the real worker.js emitted next to this bootstrap.
await import('./worker.js');
