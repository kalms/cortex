/**
 * HTTP freshness adapter — the two-signal model (spec §1).
 *
 * `computeEtag` derives a strong cache validator from the index BASELINE
 * (indexed_commit/dirty_sig/indexed_at) — it changes only when the graph DB is
 * republished (reindex), so it is the right `If-None-Match` target for the
 * per-project data endpoints.
 *
 * `httpFreshnessFor` returns the live staleness VERDICT (whether the index is
 * behind the working tree) by reusing `freshnessForContext`. It resolves any
 * project's repo path from the registry by name and opens its own short-lived
 * readonly handle, so it needs no GraphStore internals. `canonical` mirrors the
 * `cortex freshness` CLI: dbPath === the repo's .cortex/db.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { freshnessForContext, type Freshness } from "./freshness.js";
import { readIndexMeta, type IndexMeta } from "../graph/index-meta.js";
import { resolveGraphDbForRead, resolveCortexDbPath } from "../db/resolve-path.js";

const ETAG_VERSION = 1;

/** Strong validator: `"<version>:<project>:<sha256(baseline)[:32]>"`. */
export function computeEtag(project: string | null, meta: IndexMeta | null): string {
  const proj = project ?? "_";
  const basis = `${ETAG_VERSION}:${proj}:${meta?.indexed_commit ?? ""}|${meta?.indexed_dirty_sig ?? ""}|${meta?.indexed_at ?? ""}`;
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 32);
  return `"${ETAG_VERSION}:${proj}:${hash}"`;
}

export interface HttpFreshness {
  verdict: Freshness;
  etag: string;
}

/** Compute the verdict + ETag for a resolved project name (null/unknown →
 *  `unknown` verdict + baseline-less ETag). `registry` is the open master
 *  Registry the server already holds. */
export function httpFreshnessFor(
  project: string | null,
  registry: { findByName(name: string): { root_path: string } | null },
): HttpFreshness {
  const rootPath = project ? registry.findByName(project)?.root_path ?? null : null;
  if (!rootPath) {
    return {
      verdict: { state: "unknown", note: "project not in registry — freshness unavailable" },
      etag: computeEtag(project, null),
    };
  }
  const dbPath = resolveGraphDbForRead(rootPath) ?? resolveCortexDbPath(rootPath);
  let handle: Database.Database | null = null;
  let meta: IndexMeta | null = null;
  let verdict: Freshness;
  try {
    handle = new Database(dbPath, { readonly: true, fileMustExist: true });
    meta = readIndexMeta(handle);
    const canonical = dbPath === resolveCortexDbPath(rootPath);
    verdict = freshnessForContext({ repoPath: rootPath, graphDb: handle, canonical });
  } catch {
    verdict = { state: "empty", note: "graph DB unavailable" };
  } finally {
    handle?.close();
  }
  return { verdict, etag: computeEtag(project, meta) };
}
