# Cortex Indexer Consumption Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cortex's side of the indexer split — the prebuilt-binary fetcher, the exact-version pin, the runtime guard, and the CBM kill — additively, without breaking the existing in-tree build.

**Architecture:** A new `src/indexer/` module owns binary resolution (`resolveIndexerBinary`) and the version contract (`ensureIndexer`, `CORTEX_INDEXER_VERSION`, `indexerAssetName`). A standalone `scripts/fetch-indexer.mjs` (plain ESM, runnable at postinstall before any build) downloads + checksum-verifies the platform binary. This plan wires the *resolver* into the live indexer call path (killing the CBM alias) but leaves the *version assertion* and the *postinstall flip* for the cut-over plan, since they require the new binary's `--version` JSON to exist first.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, Node built-ins (`node:crypto`, `node:zlib`, `node:http` for test fixtures), `execFile`.

**Scope boundary:** This is plan #2 of three. Plan #1 (`cortex-indexer` repo standup + release pipeline) and plan #3 (cortex history purge + postinstall cut-over) are separate. This plan keeps `internal/indexer/` and the `build-indexer.sh` postinstall in place.

---

## File Structure

- **Create** `src/indexer/version.ts` — `CORTEX_INDEXER_VERSION` constant + `indexerAssetName(platform, arch)` (canonical asset-name/supported-platform logic).
- **Create** `src/indexer/binary.ts` — `resolveIndexerBinary()`, `ensureIndexer()`, `IndexerNotInstalledError`, `IndexerVersionMismatchError`.
- **Create** `scripts/fetch-indexer.mjs` — postinstall downloader (plain ESM; mirrors version+asset logic with a drift-guard test).
- **Create** `tests/indexer/version.test.ts`, `tests/indexer/binary.test.ts`, `tests/indexer/fetch-indexer.test.ts`.
- **Modify** `src/mcp-server/tools/code-tools.ts:215-221,326-335` — replace the `INDEXER_BINARY` const (incl. CBM alias) with `resolveIndexerBinary()` inside `invokeIndexer`.
- **Modify** `src/graph/store.ts:266`, `src/events/types.ts:23`, `tests/api/decisions-adapter.test.ts:17` — scrub CBM naming residue.
- **Modify** `package.json` — add a `fetch-indexer` script (postinstall flip deferred to cut-over).

---

## Task 1: Version pin + asset-name mapping

**Files:**
- Create: `src/indexer/version.ts`
- Test: `tests/indexer/version.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/indexer/version.test.ts
import { describe, expect, it } from "vitest";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "../../src/indexer/version.js";

describe("indexerAssetName", () => {
  it("maps the four supported targets to tarball names", () => {
    const v = CORTEX_INDEXER_VERSION;
    expect(indexerAssetName("darwin", "arm64")).toBe(`cortex-indexer-${v}-darwin-arm64.tar.gz`);
    expect(indexerAssetName("darwin", "x64")).toBe(`cortex-indexer-${v}-darwin-x64.tar.gz`);
    expect(indexerAssetName("linux", "x64")).toBe(`cortex-indexer-${v}-linux-x64.tar.gz`);
    expect(indexerAssetName("linux", "arm64")).toBe(`cortex-indexer-${v}-linux-arm64.tar.gz`);
  });

  it("returns null for unsupported platform/arch", () => {
    expect(indexerAssetName("win32", "x64")).toBeNull();
    expect(indexerAssetName("linux", "ia32")).toBeNull();
    expect(indexerAssetName("darwin", "ppc64")).toBeNull();
  });

  it("pins an exact semver string", () => {
    expect(CORTEX_INDEXER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/version.test.ts`
Expected: FAIL — cannot resolve `../../src/indexer/version.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/indexer/version.ts

/**
 * The exact cortex-indexer release this build of cortex is pinned to.
 * Single source of truth for the fetcher and the runtime version check.
 * Bumping the indexer is an explicit, reviewable cortex commit.
 *
 * NOTE: mirror any change in scripts/fetch-indexer.mjs (drift-guard test in
 * tests/indexer/fetch-indexer.test.ts enforces equality).
 */
export const CORTEX_INDEXER_VERSION = "0.3.0";

/** Supported (platform, arch) targets → release asset basename, else null. */
const SUPPORTED = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
]);

export function indexerAssetName(
  platform: NodeJS.Platform | string,
  arch: string,
): string | null {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) return null;
  return `cortex-indexer-${CORTEX_INDEXER_VERSION}-${key}.tar.gz`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/version.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/version.ts tests/indexer/version.test.ts
git commit -m "feat(indexer): version pin + release asset-name mapping"
```

---

## Task 2: Binary resolution (no CBM alias)

**Files:**
- Create: `src/indexer/binary.ts`
- Test: `tests/indexer/binary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/indexer/binary.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { resolveIndexerBinary } from "../../src/indexer/binary.js";

const ORIG = process.env.CORTEX_INDEXER_PATH;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CORTEX_INDEXER_PATH;
  else process.env.CORTEX_INDEXER_PATH = ORIG;
  delete process.env.CBM_BINARY_PATH;
});

describe("resolveIndexerBinary", () => {
  it("honors CORTEX_INDEXER_PATH override", () => {
    process.env.CORTEX_INDEXER_PATH = "/custom/indexer";
    expect(resolveIndexerBinary()).toBe("/custom/indexer");
  });

  it("falls back to the bundled bin/cortex-indexer path", () => {
    delete process.env.CORTEX_INDEXER_PATH;
    expect(resolveIndexerBinary()).toMatch(/[/\\]bin[/\\]cortex-indexer$/);
  });

  it("ignores the dead CBM_BINARY_PATH alias", () => {
    delete process.env.CORTEX_INDEXER_PATH;
    process.env.CBM_BINARY_PATH = "/legacy/cbm";
    expect(resolveIndexerBinary()).not.toBe("/legacy/cbm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/binary.test.ts`
Expected: FAIL — cannot resolve `../../src/indexer/binary.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/indexer/binary.ts
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

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
```

> Note: `LOCAL_INDEXER` here is `../../bin/...` from `src/indexer/`, which after `tsc` emit is `dist/indexer/` → `dist/../../bin` = `<repo>/bin`. Matches the legacy resolution in `code-tools.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/binary.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/binary.ts tests/indexer/binary.test.ts
git commit -m "feat(indexer): binary path resolver without CBM alias"
```

---

## Task 3: ensureIndexer — presence + exact-version assertion

**Files:**
- Modify: `src/indexer/binary.ts`
- Test: `tests/indexer/binary.test.ts`

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// append to tests/indexer/binary.test.ts
import { ensureIndexer, IndexerNotInstalledError, IndexerVersionMismatchError } from "../../src/indexer/binary.js";
import { CORTEX_INDEXER_VERSION } from "../../src/indexer/version.js";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Write a fake indexer that prints the given JSON for `--version`. */
function fakeIndexer(versionJson: object): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-indexer-"));
  const bin = join(dir, "cortex-indexer");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo '${JSON.stringify(versionJson)}'; fi\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("ensureIndexer", () => {
  afterEach(() => { delete process.env.CORTEX_INDEXER_PATH; });

  it("returns the path when version matches the pin", async () => {
    const bin = fakeIndexer({ version: CORTEX_INDEXER_VERSION, schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    await expect(ensureIndexer({ noCache: true })).resolves.toBe(bin);
  });

  it("throws IndexerNotInstalledError when the binary is absent", async () => {
    process.env.CORTEX_INDEXER_PATH = "/nonexistent/cortex-indexer";
    await expect(ensureIndexer({ noCache: true })).rejects.toBeInstanceOf(IndexerNotInstalledError);
  });

  it("throws IndexerVersionMismatchError on a version mismatch (default path)", async () => {
    const bin = fakeIndexer({ version: "9.9.9", schema: 1, protocol: 1 });
    // Mismatch is only asserted when NOT using CORTEX_INDEXER_PATH override,
    // so point LOCAL resolution at it via the override-bypass flag.
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true }))
      .rejects.toBeInstanceOf(IndexerVersionMismatchError);
  });

  it("skips the version assertion when CORTEX_INDEXER_PATH is set (dev override)", async () => {
    const bin = fakeIndexer({ version: "9.9.9", schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    await expect(ensureIndexer({ noCache: true })).resolves.toBe(bin);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/binary.test.ts -t ensureIndexer`
Expected: FAIL — `ensureIndexer`/error classes not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/indexer/binary.ts`)**

```ts
// append to src/indexer/binary.ts
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "./version.js";

const execFileAsync = promisify(execFile);

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
      reported = undefined; // legacy binary without --version JSON
    }
    if (reported && reported !== CORTEX_INDEXER_VERSION) {
      throw new IndexerVersionMismatchError(reported, CORTEX_INDEXER_VERSION);
    }
  }

  if (!opts.noCache) cachedPath = binary;
  return binary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/binary.test.ts`
Expected: PASS (all binary tests, incl. 4 ensureIndexer cases).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/binary.ts tests/indexer/binary.test.ts
git commit -m "feat(indexer): ensureIndexer presence + exact-version guard"
```

---

## Task 4: fetch-indexer.mjs — pure helpers + drift guard

**Files:**
- Create: `scripts/fetch-indexer.mjs`
- Test: `tests/indexer/fetch-indexer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/indexer/fetch-indexer.test.ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assetNameFor, FETCH_INDEXER_VERSION, sha256Hex } from "../../scripts/fetch-indexer.mjs";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "../../src/indexer/version.js";

describe("fetch-indexer pure helpers", () => {
  it("version + asset mapping stay in lockstep with src/indexer/version.ts (drift guard)", () => {
    expect(FETCH_INDEXER_VERSION).toBe(CORTEX_INDEXER_VERSION);
    for (const [p, a] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"]]) {
      expect(assetNameFor(p, a)).toBe(indexerAssetName(p, a));
    }
    expect(assetNameFor("win32", "x64")).toBeNull();
  });

  it("computes sha256 of a buffer", () => {
    const buf = Buffer.from("hello");
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(sha256Hex(buf)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/fetch-indexer.test.ts`
Expected: FAIL — cannot resolve `scripts/fetch-indexer.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/fetch-indexer.mjs
// Postinstall downloader for the prebuilt cortex-indexer binary. Plain ESM:
// runs at `npm install` time before any TypeScript build, so it must not
// import from dist/ or src/.
import { createHash } from "node:crypto";

// MUST equal CORTEX_INDEXER_VERSION in src/indexer/version.ts (drift-guard test).
export const FETCH_INDEXER_VERSION = "0.3.0";

const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);

export function assetNameFor(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) return null;
  return `cortex-indexer-${FETCH_INDEXER_VERSION}-${key}.tar.gz`;
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/fetch-indexer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-indexer.mjs tests/indexer/fetch-indexer.test.ts
git commit -m "feat(indexer): fetch-indexer pure helpers + version drift guard"
```

---

## Task 5: fetch-indexer.mjs — download, verify, extract, soft-warn

**Files:**
- Modify: `scripts/fetch-indexer.mjs`
- Test: `tests/indexer/fetch-indexer.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to tests/indexer/fetch-indexer.test.ts
import { fetchIndexer } from "../../scripts/fetch-indexer.mjs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build a real .tar.gz containing an executable `cortex-indexer`, return {buf, sha}. */
function makeAssetTarball() {
  const dir = mkdtempSync(join(tmpdir(), "asset-"));
  const bin = join(dir, "cortex-indexer");
  writeFileSync(bin, "#!/bin/sh\necho ok\n");
  chmodSync(bin, 0o755);
  const tgz = join(dir, "asset.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", dir, "cortex-indexer"]);
  const buf = readFileSync(tgz);
  return { buf, sha: sha256Hex(buf) };
}

describe("fetchIndexer download", () => {
  it("downloads, verifies sha256, extracts, and installs the binary", async () => {
    const { buf, sha } = makeAssetTarball();
    const asset = assetNameFor(process.platform, process.arch);
    if (!asset) return; // unsupported runner platform — covered by soft-warn test below
    const server = createServer((req, res) => {
      if (req.url.endsWith(".sha256")) { res.end(`${sha}  ${asset}\n`); return; }
      res.end(buf);
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const destDir = mkdtempSync(join(tmpdir(), "bin-"));

    const result = await fetchIndexer({
      baseUrl: `http://127.0.0.1:${port}`,
      destDir,
      cacheDir: mkdtempSync(join(tmpdir(), "cache-")),
    });
    server.close();

    expect(result.installed).toBe(true);
    expect(existsSync(join(destDir, "cortex-indexer"))).toBe(true);
  });

  it("soft-warns (no throw, installed=false) when the asset 404s", async () => {
    const server = createServer((_req, res) => { res.statusCode = 404; res.end("nope"); });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const result = await fetchIndexer({
      baseUrl: `http://127.0.0.1:${port}`,
      destDir: mkdtempSync(join(tmpdir(), "bin-")),
      cacheDir: mkdtempSync(join(tmpdir(), "cache-")),
    });
    server.close();
    expect(result.installed).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/fetch-indexer.test.ts -t "fetchIndexer download"`
Expected: FAIL — `fetchIndexer` not exported.

- [ ] **Step 3: Write minimal implementation (append to `scripts/fetch-indexer.mjs`)**

```js
// append to scripts/fetch-indexer.mjs
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const DEFAULT_BASE_URL =
  process.env.CORTEX_INDEXER_BASE_URL ||
  // TODO(cut-over): confirm the GitHub owner/repo slug before wiring postinstall.
  "https://github.com/ruevu/cortex-indexer/releases/download";

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download + verify + extract the pinned binary into destDir/cortex-indexer.
 * Never throws on an expected miss (unsupported platform, 404, offline):
 * returns { installed:false, reason } so postinstall can warn and exit 0.
 */
export async function fetchIndexer({ baseUrl = DEFAULT_BASE_URL, destDir, cacheDir } = {}) {
  const asset = assetNameFor(process.platform, process.arch);
  if (!asset) {
    return { installed: false, reason: `no prebuilt asset for ${process.platform}-${process.arch}` };
  }
  const base = `${baseUrl}/v${FETCH_INDEXER_VERSION}`;
  const cacheBin = join(cacheDir, FETCH_INDEXER_VERSION, `${process.platform}-${process.arch}`, "cortex-indexer");
  mkdirSync(destDir, { recursive: true });

  try {
    if (!existsSync(cacheBin)) {
      const [tgz, shaText] = await Promise.all([
        download(`${base}/${asset}`),
        download(`${base}/${asset}.sha256`),
      ]);
      const want = shaText.toString("utf8").trim().split(/\s+/)[0];
      const got = sha256Hex(tgz);
      if (want !== got) throw new Error(`checksum mismatch for ${asset}: want ${want}, got ${got}`);

      mkdirSync(join(cacheBin, ".."), { recursive: true });
      const tmpTgz = `${cacheBin}.tar.gz`;
      writeFileSync(tmpTgz, tgz);
      execFileSync("tar", ["-xzf", tmpTgz, "-C", join(cacheBin, ".."), "cortex-indexer"]);
      chmodSync(cacheBin, 0o755);
    }
    copyFileSync(cacheBin, join(destDir, "cortex-indexer"));
    chmodSync(join(destDir, "cortex-indexer"), 0o755);
    return { installed: true, from: cacheBin };
  } catch (e) {
    return { installed: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// CLI entry: only runs when invoked directly (postinstall), not on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(new URL(".", import.meta.url).pathname, "..");
  const result = await fetchIndexer({
    destDir: join(root, "bin"),
    cacheDir: join(homedir(), ".cache", "cortex-indexer", "bin"),
  });
  if (result.installed) {
    console.log(`cortex-indexer ${FETCH_INDEXER_VERSION} installed (${result.from ?? "downloaded"}).`);
  } else {
    console.warn(
      `WARN: cortex-indexer not installed (${result.reason}). ` +
      `It will be fetched on first use, or set CORTEX_INDEXER_PATH. See docs.`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/fetch-indexer.test.ts`
Expected: PASS (download + soft-warn cases; download case is a no-op on unsupported CI arch, which is fine).

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-indexer.mjs tests/indexer/fetch-indexer.test.ts
git commit -m "feat(indexer): fetch-indexer download/verify/extract with soft-warn"
```

---

## Task 6: Wire resolver into the live call path; kill the CBM alias

**Files:**
- Modify: `src/mcp-server/tools/code-tools.ts:215-221,326-335`

- [ ] **Step 1: Write the failing test**

```ts
// tests/indexer/code-tools-binary.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const src = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../src/mcp-server/tools/code-tools.ts"),
  "utf8",
);

describe("code-tools indexer wiring", () => {
  it("no longer references the dead CBM_BINARY_PATH alias", () => {
    expect(src).not.toContain("CBM_BINARY_PATH");
  });
  it("resolves the binary via resolveIndexerBinary", () => {
    expect(src).toContain("resolveIndexerBinary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/code-tools-binary.test.ts`
Expected: FAIL — file still contains `CBM_BINARY_PATH`, lacks `resolveIndexerBinary`.

- [ ] **Step 3: Edit `code-tools.ts`**

Replace lines 215-221:

```ts
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIndexerBinary } from "../../indexer/binary.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RG_MAX_BUFFER = 64 * 1024 * 1024;
```

(Delete the `LOCAL_INDEXER`, the CBM comment, and the `INDEXER_BINARY` const.)

In `invokeIndexer` (around line 332), replace the `execFileAsync(INDEXER_BINARY, ...)` line with a resolved local:

```ts
async function invokeIndexer(
  tool: string,
  args: Record<string, unknown>,
  subprocEnv: NodeJS.ProcessEnv,
): Promise<IndexerCallResult> {
  const binary = resolveIndexerBinary();
  try {
    const { stdout } = await execFileAsync(binary, ["cli", tool, JSON.stringify(args)], {
      timeout: 120_000,
      env: subprocEnv,
    });
```

(The rest of `invokeIndexer` is unchanged.)

> Deferred to cut-over (plan #3): swap `resolveIndexerBinary()` here for `await ensureIndexer()` once the published binary emits `--version` JSON, and flip `postinstall` to `fetch-indexer.mjs`. Doing it now would assert a version the in-tree legacy binary doesn't report.

- [ ] **Step 4: Run tests to verify pass + no regression**

Run: `npx vitest run tests/indexer/code-tools-binary.test.ts tests/mcp-server`
Expected: PASS (new wiring tests + existing mcp-server suite green).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/code-tools.ts tests/indexer/code-tools-binary.test.ts
git commit -m "refactor(indexer): resolve binary via resolveIndexerBinary, drop CBM_BINARY_PATH"
```

---

## Task 7: Scrub CBM naming residue from code

**Files:**
- Modify: `src/graph/store.ts:266`, `src/events/types.ts:23`, `tests/api/decisions-adapter.test.ts:17`

- [ ] **Step 1: Make the edits**

In `src/graph/store.ts:266` — rewrite the comment dropping CBM terms:

```ts
   * no label-map collapse, no separate node-kind table. Decision/PR/TODO rows
```

In `src/events/types.ts:23`:

```ts
  /** Indexer project name if attached, else ''. */
```

In `tests/api/decisions-adapter.test.ts:17`:

```ts
  resolution: "SQLite via better-sqlite3, attached read-only from the indexer.",
```

- [ ] **Step 2: Run the code-dir grep acceptance gate**

Run:
```bash
grep -rniI 'cbm' src/ scripts/ tests/ hooks/ bin/ package.json --exclude-dir=.venv | grep -v node_modules
```
Expected: **no output** (exit 1). `internal/indexer/` and `docs/` are intentionally out of this gate's scope — `internal/indexer/` is removed at cut-over (plan #3), and the design/plan docs legitimately discuss "cbm".

- [ ] **Step 3: Run affected suites**

Run: `npx vitest run tests/api/decisions-adapter.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/graph/store.ts src/events/types.ts tests/api/decisions-adapter.test.ts
git commit -m "chore(indexer): scrub CBM naming residue from code + comments"
```

---

## Task 8: Add fetch-indexer npm script (postinstall flip deferred)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

In `package.json` `scripts`, add (leave `postinstall` pointing at `build-indexer.sh`):

```json
    "fetch-indexer": "node scripts/fetch-indexer.mjs",
```

- [ ] **Step 2: Verify it parses + the script imports cleanly**

Run: `node -e "require('./package.json')" && node --check scripts/fetch-indexer.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS (whole suite green).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(indexer): add fetch-indexer npm script (postinstall flip deferred to cut-over)"
```

---

## Self-Review

**Spec coverage** (against `2026-06-10-cortex-indexer-repo-split-design.md`):
- Distribution / fetch (postinstall download, sha256, cache, soft-warn) → Tasks 4-5, 8. *(postinstall flip itself is cut-over, plan #3 — noted.)*
- Exact version pin + runtime check → Tasks 1, 3. *(live wiring of `ensureIndexer` deferred to cut-over — noted in Task 6.)*
- CBM kill (alias + naming residue + grep gate) → Tasks 6, 7.
- Platform matrix (4 targets, others null/soft-warn) → Tasks 1, 5.
- `cortex-indexer` repo standup + release pipeline → **plan #1** (out of scope here).
- History surgery + purge + force-push → **plan #3** (out of scope here).

**Placeholder scan:** No "TBD/TODO" left except the deliberately-flagged GitHub-owner slug in `DEFAULT_BASE_URL` (Task 5) — an open item carried from the spec, confirmed at cut-over; tests inject `baseUrl` so it does not block this plan.

**Type/name consistency:** `CORTEX_INDEXER_VERSION` / `indexerAssetName` (TS) mirrored by `FETCH_INDEXER_VERSION` / `assetNameFor` (mjs) with a drift-guard test (Task 4). `resolveIndexerBinary`, `ensureIndexer`, `IndexerNotInstalledError`, `IndexerVersionMismatchError` are defined in Task 2-3 and consumed consistently in Task 6.

**Open items for cut-over (plan #3):** confirm GitHub owner slug; swap `resolveIndexerBinary()` → `ensureIndexer()` in `invokeIndexer`; flip `postinstall` to `fetch-indexer.mjs`; remove `internal/indexer/` so the grep gate can widen.
