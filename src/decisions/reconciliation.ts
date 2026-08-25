import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

export type Verdict = "match" | "partial" | "drift";
export type ReconciliationState = Verdict | "unknown";

export interface GovernedRef {
  target_kind: string; // "qn" | "path" | "decision" | "pr"
  target_ref: string;
}

/** Reject absolute paths and any '..' segment so a governed ref can never
 *  escape the repo root when joined to it. Backslashes are treated as
 *  separators too, for safety on mixed inputs. */
function isUnsafePath(p: string): boolean {
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return true; // absolute (posix or windows)
  return p.split(/[\\/]/).includes("..");
}

/**
 * Resolve a GOVERNS ref to a repo-relative file path, or null if it does not
 * name code (decision/pr refs, or a bare dotted qn we can't map to a file
 * without the graph). "path" refs pass through; "qn" refs use the file part
 * before "::".
 */
export function refToFile(ref: GovernedRef): string | null {
  if (ref.target_kind === "decision" || ref.target_kind === "pr") return null;
  const r = ref.target_ref;
  const candidate =
    r.includes("::") ? r.slice(0, r.indexOf("::"))
    : ref.target_kind === "path" ? r
    : (r.includes("/") || /\.[a-z0-9]+$/i.test(r)) ? r
    : null;
  if (candidate == null) return null;
  if (isUnsafePath(candidate)) return null; // defense-in-depth: never escape the repo
  return candidate;
}

/**
 * Working-tree hash of a decision's governed source. Reads CURRENT bytes from
 * disk (NOT git HEAD) so in-session edits flip a decision stale-pending before
 * any commit — the property that makes reconciliation live. Reuses the
 * sha256(sorted(ref \0 bytes)) shape from src/db/cache.ts:grammarPackHash.
 *
 * A directory ref is walked (sorted) so frame/folder governance hashes its
 * whole subtree. A missing file contributes a "<missing>" sentinel so deletion
 * registers as drift. Unresolvable refs contribute only their ref string, so
 * relinking still changes the hash deterministically.
 */
export function hashGovernedSource(repoPath: string, refs: GovernedRef[]): string {
  const h = createHash("sha256");
  const sorted = [...refs].sort((a, b) => (a.target_ref < b.target_ref ? -1 : a.target_ref > b.target_ref ? 1 : 0));
  for (const ref of sorted) {
    h.update(ref.target_ref);
    h.update("\0");
    const rel = refToFile(ref);
    if (rel == null) { h.update("<unresolved>\0"); continue; }
    const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
    if (!existsSync(abs)) { h.update("<missing>\0"); continue; }
    const st = statSync(abs);
    if (st.isDirectory()) hashDir(h, abs, abs); else h.update(readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
}

function hashDir(h: ReturnType<typeof createHash>, root: string, dir: string): void {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) hashDir(h, root, p);
    else { h.update(relative(root, p)); h.update("\0"); h.update(readFileSync(p)); }
  }
}

/** Whether one governed ref points at something that exists right now. */
export type RefResolution = "resolved" | "missing" | "unresolvable";

export interface ResolvedRef {
  ref: GovernedRef;
  state: RefResolution;
  /** Repo-relative path when one could be derived, else null. */
  path: string | null;
}

/**
 * Per-ref resolution state — the information `hashGovernedSource` computes and
 * discards. It folds each ref into a `<missing>`/`<unresolved>` sentinel and
 * returns one opaque digest; callers that need to explain a verdict need to
 * know WHICH refs failed. Same traversal, same `refToFile`, no hashing.
 */
export function resolveGovernedRefs(repoPath: string, refs: GovernedRef[]): ResolvedRef[] {
  return refs.map((ref) => {
    const rel = refToFile(ref);
    if (rel == null) return { ref, state: "unresolvable" as const, path: null };
    const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
    return { ref, state: existsSync(abs) ? ("resolved" as const) : ("missing" as const), path: rel };
  });
}

/**
 * Project the two stored axes (status, reconciliation verdict) into a single
 * human-facing display state. "stale" is active ∧ drift — never stored.
 */
export function displayState(status: string, verdict: string | null | undefined): string {
  if (status !== "active") return status;
  switch (verdict) {
    case "match": return "active";
    case "partial": return "active · drifting";
    case "drift": return "stale";
    default: return "active · unreconciled"; // "unknown" or null
  }
}
