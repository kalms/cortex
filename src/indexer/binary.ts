import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "./version.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const execFileAsync = promisify(execFile);

/** Bundled location written by the fetcher / legacy build: <repo>/bin/cortex-indexer. */
export const LOCAL_INDEXER = join(__dirname, "..", "..", "bin", "cortex-indexer");

/**
 * Resolve the indexer binary path. `CORTEX_INDEXER_PATH` is the sole override
 * (dev workflow: point at a locally built binary). The legacy `CBM_BINARY_PATH`
 * alias is intentionally NOT consulted — it was removed with the repo split.
 */
export function resolveIndexerBinary(): string {
  return process.env.CORTEX_INDEXER_PATH || LOCAL_INDEXER;
}

export class IndexerNotInstalledError extends Error {
  constructor(binaryPath: string) {
    const asset = indexerAssetName(process.platform, process.arch);
    const platformNote = asset
      ? `Expected a prebuilt binary for ${process.platform}-${process.arch}.`
      : `No prebuilt binary is published for ${process.platform}-${process.arch}; build cortex-indexer from source.`;
    super(
      `cortex-indexer not found at ${binaryPath}. ${platformNote} ` +
      `Run \`npm run fetch-indexer\`, or build it from the cortex-indexer repo and set CORTEX_INDEXER_PATH to the binary.`,
    );
    this.name = "IndexerNotInstalledError";
  }
}

export class IndexerVersionMismatchError extends Error {
  constructor(found: string, expected: string) {
    super(
      `cortex-indexer version mismatch: binary reports ${found}, cortex expects ${expected}. ` +
      `Run \`npm run fetch-indexer\` to install the pinned version, then reindex.`,
    );
    this.name = "IndexerVersionMismatchError";
  }
}

type EnsureOpts = {
  /** Bypass the resolve+verify cache (tests). */
  noCache?: boolean;
  /** Explicit binary path, bypassing resolveIndexerBinary (tests). */
  binaryPath?: string;
  /** Force the version assertion even without an env override (tests). */
  assertVersion?: boolean;
};

let cachedPath: string | undefined;

/**
 * Resolve, verify presence, and (unless overridden) assert the version of the
 * indexer binary. Lazy + cached: the `--version` exec runs at most once per
 * process. When CORTEX_INDEXER_PATH is set the version assertion is skipped so
 * local dev can run a freshly built binary.
 */
export async function ensureIndexer(opts: EnsureOpts = {}): Promise<string> {
  if (!opts.noCache && cachedPath) return cachedPath;

  const usingOverride = !!process.env.CORTEX_INDEXER_PATH && !opts.binaryPath;
  const binary = opts.binaryPath ?? resolveIndexerBinary();

  try {
    accessSync(binary, fsConstants.X_OK);
  } catch {
    throw new IndexerNotInstalledError(binary);
  }

  const shouldAssert = opts.assertVersion || !usingOverride;
  if (shouldAssert) {
    let reported: string | undefined;
    try {
      const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000 });
      reported = (JSON.parse(stdout) as { version?: string }).version;
    } catch {
      // TODO(cut-over): narrow this once the release pipeline ships a
      // --version-emitting binary — tolerate only non-JSON/missing-field
      // (SyntaxError), but surface spawn errors, non-zero exits, and timeouts
      // instead of silently treating them as "legacy".
      reported = undefined; // legacy binary without --version JSON
    }
    if (reported && reported !== CORTEX_INDEXER_VERSION) {
      throw new IndexerVersionMismatchError(reported, CORTEX_INDEXER_VERSION);
    }
  }

  if (!opts.noCache) cachedPath = binary;
  return binary;
}
