import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
  Server as HttpServer,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, sep } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { GraphStore } from "../graph/store.js";
import { listProjectsUnified, openProjectStore } from "../graph/code-queries.js";
import { Registry } from "../db/registry.js";
import { migrateCacheToRegistry, importLegacyRegistry } from "../db/registry-migration.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import { openDecisionsDb } from "../decisions/db.js";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../db/resolve-path.js";
import { buildAdaptedDecision, buildAdaptedDecisions, type FrameInfo } from "./api-decisions.js";
import { buildAdaptedTodos } from "./api-todos.js";
import { buildAdaptedStory, buildAdaptedStoryDetail } from "./api-stories.js";
import { buildFileEdges } from "./api-edges.js";
import { buildFrameMap } from "../frame-extraction/positioning/frame-map.js";
import { STAGE_W, STAGE_H } from "../frame-extraction/positioning/frame-layout.js";
import { positionAggregates } from "../frame-extraction/positioning/aggregate-positioning.js";
import { respond, respondError } from "./api-respond.js";
import { httpFreshnessFor } from "./api-freshness.js";
import {
  resolveBindHost, methodAllowed, corsHeadersFor, checkAuth, safeStaticPath, SECURITY_HEADERS, urlTooLong,
} from "./api-middleware.js";
import {
  CONTRACT_VERSION, GraphResponseSchema, ProjectsResponseSchema, FramesResponseSchema,
  FileEdgesResponseSchema, AggregatesResponseSchema, DecisionsResponseSchema,
  DecisionDetailResponseSchema, TodosResponseSchema, FreshnessResponseSchema, HealthResponseSchema,
  ProjectParamSchema, DecisionIdParamSchema, PresencePostSchema, PresenceAckResponseSchema,
  ShowFocusPostSchema, ShowFocusAckResponseSchema,
  StoriesResponseSchema, StoryDetailResponseSchema, StoryIdParamSchema,
  ShowAdvancePostSchema, ShowAdvanceAckResponseSchema,
  type PresencePost, type ShowFocusPost, type ShowAdvancePost,
} from "./api-schemas.js";
import { TodosRepository } from "../todos/repository.js";
import { TodoLinksRepository } from "../todos/links-repository.js";
import { StoriesRepository, StoryStepsRepository } from "../stories/repository.js";
import { parseRef } from "../ids/short-id.js";
import { canonicalRepoPath } from "../db/git-root.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const VIEWER_DIR = join(PROJECT_ROOT, "src", "viewer", "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Cap on the `POST /api/presence` request body (bytes). A presence beacon is
 *  a handful of short strings + up to 50 short refs — 16KB is generous
 *  headroom while still bounding a malicious/misbehaving sender. */
const MAX_PRESENCE_BODY = 16 * 1024;

/** Read + JSON-parse a request body, bounded by `maxBytes`. Resolves `null`
 *  (never rejects) on an oversized body, a socket error, or invalid JSON —
 *  the caller turns that into a 400/413-equivalent response uniformly. */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown | null> {
  return new Promise((resolvePromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        resolvePromise(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolvePromise(null);
      }
    });
    req.on("error", () => resolvePromise(null));
  });
}

/**
 * Handle returned by {@link startViewerServer}.
 *
 * The caller needs the raw `HttpServer` so it can attach additional listeners
 * (notably the WebSocket server's `upgrade` handler). `port` is `-1` and
 * `httpServer` is `null` when the requested port was unavailable.
 */
export interface ViewerServerHandle {
  port: number;
  httpServer: HttpServer | null;
  /**
   * Release server-held resources (HTTP listener + the master Registry handle).
   * Intended for programmatic/embedded callers and tests. The long-running MCP
   * entrypoint (src/index.ts) does NOT call this — like its sibling resources
   * (graph store, decisions DB, resolver pool) the registry handle is
   * process-lifetime and reclaimed by the OS / better-sqlite3 atexit on exit.
   */
  close(): void;
}

/** Outcome of a single bind attempt. */
export type BindOutcome = { ok: true } | { ok: false; error: NodeJS.ErrnoException };

/** A decisions repo pair resolved for one viewer request, plus a `close` the
 *  caller MUST invoke (a no-op for the server-bound home repo). */
export interface ProjectDecisions {
  decisions: DecisionsRepository;
  links: DecisionLinksRepository;
  owned: boolean;
  close(): void;
}

const NOOP_CLOSE = () => {};

/** A todos repo pair resolved for one viewer request, plus a `close` the
 *  caller MUST invoke (a no-op for the server-bound home repo). */
export interface ProjectTodos {
  todos: TodosRepository;
  links: TodoLinksRepository;
  owned: boolean;
  close(): void;
}

/**
 * Resolve the todos repos for a viewer request's `project`, mirroring
 * {@link openProjectDecisions}.
 *
 * Todos share the same decisions DB path (`~/.cortex/<repo-id>/decisions.db`),
 * so this follows the same resolution logic: the server-bound (home) repos are
 * returned for the bound project or a project unknown to the registry; any OTHER
 * registered project has its decisions DB opened and the caller MUST `close()` it
 * (`owned: true`).
 */
export function openProjectTodos(
  boundTodos: TodosRepository,
  boundLinks: TodoLinksRepository,
  boundProject: string | null | undefined,
  requestedProject: string | null | undefined,
  registry: { findByName(name: string): { root_path: string } | null },
): ProjectTodos {
  if (!requestedProject || requestedProject === boundProject) {
    return { todos: boundTodos, links: boundLinks, owned: false, close: NOOP_CLOSE };
  }
  const rootPath = registry.findByName(requestedProject)?.root_path ?? null;
  if (!rootPath) {
    return { todos: boundTodos, links: boundLinks, owned: false, close: NOOP_CLOSE };
  }
  const db = openDecisionsDb(resolveDecisionsDbPath(rootPath), legacyDecisionsDbPath(rootPath));
  return {
    todos: new TodosRepository(db),
    links: new TodoLinksRepository(db),
    owned: true,
    close: () => db.close(),
  };
}

/** A stories repo pair resolved for one viewer request, plus a `close` the
 *  caller MUST invoke (a no-op for the server-bound home repo). */
export interface ProjectStories {
  stories: StoriesRepository;
  steps: StoryStepsRepository;
  owned: boolean;
  close(): void;
}

/**
 * Resolve the stories repos for a viewer request's `project`, mirroring
 * {@link openProjectTodos}.
 *
 * Stories share the same decisions DB path (`~/.cortex/<repo-id>/decisions.db`),
 * so this follows the same resolution logic: the server-bound (home) repos are
 * returned for the bound project or a project unknown to the registry; any OTHER
 * registered project has its decisions DB opened and the caller MUST `close()` it
 * (`owned: true`).
 */
export function openProjectStories(
  boundStories: StoriesRepository,
  boundSteps: StoryStepsRepository,
  boundProject: string | null | undefined,
  requestedProject: string | null | undefined,
  registry: { findByName(name: string): { root_path: string } | null },
): ProjectStories {
  if (!requestedProject || requestedProject === boundProject) {
    return { stories: boundStories, steps: boundSteps, owned: false, close: NOOP_CLOSE };
  }
  const rootPath = registry.findByName(requestedProject)?.root_path ?? null;
  if (!rootPath) {
    return { stories: boundStories, steps: boundSteps, owned: false, close: NOOP_CLOSE };
  }
  const db = openDecisionsDb(resolveDecisionsDbPath(rootPath), legacyDecisionsDbPath(rootPath));
  return {
    stories: new StoriesRepository(db),
    steps: new StoryStepsRepository(db),
    owned: true,
    close: () => db.close(),
  };
}

/**
 * Resolve the decisions repos for a viewer request's `project`, mirroring
 * {@link openProjectStore}.
 *
 * The server-bound (home) repos are returned for the bound project or a project
 * unknown to the registry; any OTHER registered project has its own durable
 * decisions DB (`~/.cortex/<repo-id>/decisions.db`, the same path the write
 * path resolves) opened, and the caller MUST `close()` it (`owned: true`).
 *
 * Without this, `/api/decisions` served the startup-bound home repo's decisions
 * for every project — the project switcher changed the graph but never the
 * decisions, so e.g. cortex-indexer's decisions were invisible in the viewer.
 */
export function openProjectDecisions(
  boundDecisions: DecisionsRepository,
  boundLinks: DecisionLinksRepository,
  boundProject: string | null | undefined,
  requestedProject: string | null | undefined,
  registry: { findByName(name: string): { root_path: string } | null },
): ProjectDecisions {
  if (!requestedProject || requestedProject === boundProject) {
    return { decisions: boundDecisions, links: boundLinks, owned: false, close: NOOP_CLOSE };
  }
  const rootPath = registry.findByName(requestedProject)?.root_path ?? null;
  if (!rootPath) {
    // Unknown to the registry — best-effort fall back to the bound repo rather
    // than fabricate an empty store. Registered projects (the switcher only
    // lists those) always resolve above.
    return { decisions: boundDecisions, links: boundLinks, owned: false, close: NOOP_CLOSE };
  }
  const db = openDecisionsDb(resolveDecisionsDbPath(rootPath), legacyDecisionsDbPath(rootPath));
  return {
    decisions: new DecisionsRepository(db),
    links: new DecisionLinksRepository(db),
    owned: true,
    close: () => db.close(),
  };
}

/** Default retry policy for the viewer port. Tuned for the common failure we
 *  hit in practice: a stale/dying sibling instance still holding the port for
 *  a moment after a VS Code reload. ~5 tries over a couple of seconds gives the
 *  old listener time to release the socket without floating the URL. */
export const VIEWER_BIND_RETRIES = 5;
export const VIEWER_BIND_DELAY_MS = 300;

/**
 * Attempt to bind a (fixed) port with bounded retry on contention.
 *
 * Why this exists: the viewer used to swallow `httpServer.listen` errors
 * silently (resolve port -1, no log), so a failed bind left zero trace and the
 * MCP server ran viewer-less with no signal. This loop surfaces every attempt
 * via `log` and self-heals across the EADDRINUSE window without changing the
 * port (a floating port would defeat a "consistent viewer" URL).
 *
 * Retries ONLY on `EADDRINUSE` (transient contention). Any other error
 * (EACCES, etc.) is logged and fails fast — retrying wouldn't help.
 *
 * @returns true if a bind succeeded, false if it gave up.
 */
export async function bindWithRetry(
  attempt: () => Promise<BindOutcome>,
  opts: {
    port: number;
    retries: number;
    delayMs: number;
    log: (msg: string) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i <= opts.retries; i++) {
    const outcome = await attempt();
    if (outcome.ok) return true;
    const err = outcome.error;
    if (err.code !== "EADDRINUSE") {
      opts.log(`Cortex viewer: FAILED to bind port ${opts.port}: ${err.message}`);
      return false;
    }
    if (i < opts.retries) {
      opts.log(`Cortex viewer: port ${opts.port} busy (EADDRINUSE), retrying ${i + 1}/${opts.retries}...`);
      await sleep(opts.delayMs * (i + 1)); // linear backoff
    } else {
      opts.log(
        `Cortex viewer: FAILED to bind port ${opts.port}: ${err.message} (gave up after ${opts.retries} retries)`,
      );
    }
  }
  return false;
}

/**
 * Start the viewer HTTP server — the orchestrator for the v1 HTTP contract.
 *
 * It opens the master {@link Registry} once for the server's lifetime, then for
 * each request runs the hardening middleware chain (oversized-URL → `414`,
 * `OPTIONS` preflight, method gate → `405`, bearer auth → `401`), validates the
 * shared `?project=` param (fail-closed `400`), and dispatches through an ordered
 * route table whose order matters (`/api/decisions/:id` before `/api/decisions`,
 * static viewer last). Every data route ends in {@link respond}, which validates
 * the payload against its Zod schema and stamps the version/freshness/ETag
 * headers; error paths use {@link respondError}. Binds `CORTEX_BIND_HOST`
 * (loopback by default) via {@link bindWithRetry} and sets request/headers
 * timeouts. See [docs/architecture/http-api-contract.md] for the full model.
 *
 * @param store The home graph store the server is bound to.
 * @param indexerProject The bound (active) project name, used when a request
 *   omits `?project=`.
 * @param decisionsRepo Optional decisions repo for the home project (the
 *   `/api/decisions*` routes return `503` without it).
 * @param decisionLinksRepo Optional decision-links repo, paired with the above.
 * @param todosRepo Optional todos repo for the home project (the
 *   `/api/todos` route returns `503` without it).
 * @param todoLinksRepo Optional todo-links repo, paired with the above.
 * @param storiesRepo Optional stories repo for the home project (the
 *   `/api/stories*` routes return `503` without it).
 * @param storyStepsRepo Optional story-steps repo, paired with the above.
 * @param presence Optional presence wiring for `POST /api/presence`. Absent,
 *   the route still 200s but always reports `accepted: false` (no emit).
 *   `homeRoot` MUST already be canonicalized (see {@link canonicalRepoPath})
 *   — the route compares it against the canonicalized `repo_path` from the
 *   POST body so a session in a linked worktree matches the server's home repo.
 * @returns A {@link ViewerServerHandle}; `port` is `-1` when the bind failed.
 */
export function startViewerServer(
  store: GraphStore,
  indexerProject?: string | null,
  decisionsRepo?: DecisionsRepository,
  decisionLinksRepo?: DecisionLinksRepository,
  todosRepo?: TodosRepository,
  todoLinksRepo?: TodoLinksRepository,
  storiesRepo?: StoriesRepository,
  storyStepsRepo?: StoryStepsRepository,
  presence?: {
    homeRoot: string;
    emit: (p: PresencePost) => void;
    emitFocus: (p: ShowFocusPost) => void;
    emitAdvance: (p: ShowAdvancePost) => void;
  },
): Promise<ViewerServerHandle> {
  return new Promise((resolve) => {
    // Master registry, opened once for the server's lifetime. Seed it on first
    // run (idempotent, best-effort): carry over the pre-XDG registry, then any
    // legacy cache <slug>.db. A partial failure here recovers on next startup.
    const registry = new Registry();
    try { importLegacyRegistry(registry); } catch { /* best-effort */ }
    try { migrateCacheToRegistry(registry); } catch { /* best-effort; idempotent */ }

    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || "/";
      const parsed = new NodeURL(url, "http://localhost");
      const pathname = parsed.pathname;
      const origin = req.headers["origin"] as string | undefined;
      const cors = corsHeadersFor(origin, process.env);

      // Oversized request-target guard (cheap DoS/abuse limit, spec §4 row 7).
      if (urlTooLong(req.url)) { respondError(res, 414, "request-target too long", cors); return; }

      // CORS preflight (only answered for allowlisted origins; cors is {} otherwise).
      if (req.method === "OPTIONS") {
        if (Object.keys(cors).length > 0) { res.writeHead(204, cors); res.end(); }
        else respondError(res, 405, "method not allowed");
        return;
      }
      // Method gate. POST is otherwise disallowed (ALLOWED_METHODS is GET/HEAD
      // only) — special-cased here for the one write route rather than widening
      // the shared set, so every other path keeps its GET/HEAD-only contract.
      const isPresencePost = req.method === "POST" && pathname === "/api/presence";
      const isShowFocusPost = req.method === "POST" && pathname === "/api/show-focus";
      const isShowAdvancePost = req.method === "POST" && pathname === "/api/show-advance";
      if (!methodAllowed(req.method) && !isPresencePost && !isShowFocusPost && !isShowAdvancePost) { respondError(res, 405, "method not allowed", cors); return; }
      // Auth (API paths only; static viewer is public).
      if (pathname.startsWith("/api/") && !checkAuth(pathname, req.headers["authorization"], process.env)) {
        respondError(res, 401, "unauthorized", cors);
        return;
      }

      // Validate the shared `project` query param once (fail-closed 400).
      const projectParamRaw = parsed.searchParams.get("project") ?? undefined;
      const projectParam = ProjectParamSchema.safeParse(projectParamRaw);
      if (!projectParam.success) { respondError(res, 400, "invalid project parameter", cors); return; }
      const project = projectParam.data ?? indexerProject ?? undefined;
      const freshCtx = () => {
        const { verdict, etag } = httpFreshnessFor(project ?? null, registry);
        return { req, freshness: verdict, etag, headers: cors };
      };

      // ── /api/health (unauthenticated liveness) ──
      if (pathname === "/api/health") {
        respond(res, HealthResponseSchema, { version: CONTRACT_VERSION, ok: true as const }, { ...freshCtx() });
        return;
      }

      // ── /api/freshness ──
      if (pathname === "/api/freshness") {
        const { verdict, etag } = httpFreshnessFor(project ?? null, registry);
        respond(res, FreshnessResponseSchema, { version: CONTRACT_VERSION, ...verdict }, { req, freshness: verdict, etag, headers: cors });
        return;
      }

      // ── /api/presence ── (POST only; GET/HEAD fall through to the 405 below)
      if (pathname === "/api/presence") {
        if (!isPresencePost) { respondError(res, 405, "method not allowed", cors); return; }
        const raw = await readJsonBody(req, MAX_PRESENCE_BODY);
        const parsed = PresencePostSchema.safeParse(raw);
        if (!parsed.success) { respondError(res, 400, "invalid presence body", cors); return; }
        let accepted = false;
        if (presence) {
          // canonicalRepoPath collapses worktrees/subdirs to the main checkout root,
          // so a session in ../repo-wt-x matches the server's home repo.
          try { accepted = canonicalRepoPath(parsed.data.repo_path) === presence.homeRoot; } catch { accepted = false; }
          if (accepted) presence.emit(parsed.data);
        }
        respond(res, PresenceAckResponseSchema, { version: CONTRACT_VERSION, accepted }, freshCtx());
        return;
      }

      // ── /api/show-focus ── (POST only; GET/HEAD fall through to the 405 below)
      if (pathname === "/api/show-focus") {
        if (!isShowFocusPost) { respondError(res, 405, "method not allowed", cors); return; }
        const raw = await readJsonBody(req, MAX_PRESENCE_BODY);
        const parsed = ShowFocusPostSchema.safeParse(raw);
        if (!parsed.success) { respondError(res, 400, "invalid show-focus body", cors); return; }
        let accepted = false;
        if (presence) {
          // canonicalRepoPath collapses worktrees/subdirs to the main checkout root,
          // so a session in ../repo-wt-x matches the server's home repo.
          try { accepted = canonicalRepoPath(parsed.data.repo_path) === presence.homeRoot; } catch { accepted = false; }
          if (accepted) presence.emitFocus(parsed.data);
        }
        respond(res, ShowFocusAckResponseSchema, { version: CONTRACT_VERSION, accepted }, freshCtx());
        return;
      }

      // ── /api/show-advance ── (POST only; GET/HEAD fall through to the 405 below)
      if (pathname === "/api/show-advance") {
        if (!isShowAdvancePost) { respondError(res, 405, "method not allowed", cors); return; }
        const raw = await readJsonBody(req, MAX_PRESENCE_BODY);
        const parsed = ShowAdvancePostSchema.safeParse(raw);
        if (!parsed.success) { respondError(res, 400, "invalid show-advance body", cors); return; }
        let accepted = false;
        if (presence) {
          // canonicalRepoPath collapses worktrees/subdirs to the main checkout root,
          // so a session in ../repo-wt-x matches the server's home repo.
          try { accepted = canonicalRepoPath(parsed.data.repo_path) === presence.homeRoot; } catch { accepted = false; }
          if (accepted) presence.emitAdvance(parsed.data);
        }
        respond(res, ShowAdvanceAckResponseSchema, { version: CONTRACT_VERSION, accepted }, freshCtx());
        return;
      }

      // ── /api/graph ──
      if (pathname === "/api/graph") {
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        if (!resolved) {
          respond(res, GraphResponseSchema, { version: CONTRACT_VERSION, nodes: [], edges: [], project: project ?? null }, freshCtx());
          return;
        }
        try {
          const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
          const rawEdges = resolved.store.getAllEdgesUnified(project ?? undefined);
          const edges = rawEdges.map((e) => ({ ...e, source: e.source_id, target: e.target_id }));
          respond(res, GraphResponseSchema, { version: CONTRACT_VERSION, nodes, edges, project: project ?? null }, freshCtx());
        } finally {
          if (resolved.owned) resolved.store.close();
        }
        return;
      }

      // ── /api/projects ──
      if (pathname === "/api/projects") {
        let projects: ReturnType<typeof listProjectsUnified> = [];
        try { projects = listProjectsUnified(store); } catch { /* no ctx_projects yet */ }
        respond(res, ProjectsResponseSchema, { version: CONTRACT_VERSION, projects, active: indexerProject ?? null }, freshCtx());
        return;
      }

      // ── /api/decisions/:id ── (must precede the list route)
      if (pathname.startsWith("/api/decisions/")) {
        if (!decisionsRepo || !decisionLinksRepo) { respondError(res, 503, "decisions repos unavailable", cors); return; }
        const idRaw = decodeURIComponent(pathname.slice("/api/decisions/".length));
        const idParsed = DecisionIdParamSchema.safeParse(idRaw);
        if (!idParsed.success) { respondError(res, 400, "invalid decision id", cors); return; }
        const pd = openProjectDecisions(decisionsRepo, decisionLinksRepo, indexerProject, project, registry);
        try {
          const rec = pd.decisions.get(idParsed.data);
          if (!rec) { respondError(res, 404, "decision not found", cors); return; }
          const links = pd.links.findByDecision(idParsed.data);
          const resolved = openProjectStore(store, indexerProject, project, { registry });
          const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
          try {
            const { nodesByPath, framesByPath } = buildPathIndices(nodes);
            const decision = buildAdaptedDecision(rec, links, nodesByPath, framesByPath);
            respond(res, DecisionDetailResponseSchema, { version: CONTRACT_VERSION, decision }, freshCtx());
          } finally {
            if (resolved?.owned) resolved.store.close();
          }
        } finally {
          pd.close();
        }
        return;
      }

      // ── /api/decisions ──
      if (pathname === "/api/decisions") {
        if (!decisionsRepo || !decisionLinksRepo) { respondError(res, 503, "decisions repos unavailable", cors); return; }
        const pd = openProjectDecisions(decisionsRepo, decisionLinksRepo, indexerProject, project, registry);
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
        try {
          const records = pd.decisions.list();
          const allLinks = records.flatMap((r) => pd.links.findByDecision(r.id));
          const { nodesByPath, framesByPath } = buildPathIndices(nodes);
          const decisions = buildAdaptedDecisions(records, allLinks, nodesByPath, framesByPath);
          respond(res, DecisionsResponseSchema, { version: CONTRACT_VERSION, decisions }, freshCtx());
        } finally {
          if (resolved?.owned) resolved.store.close();
          pd.close();
        }
        return;
      }

      // ── /api/todos ──
      if (pathname === "/api/todos") {
        if (!todosRepo || !todoLinksRepo) { respondError(res, 503, "todos repos unavailable", cors); return; }
        const pt = openProjectTodos(todosRepo, todoLinksRepo, indexerProject, project, registry);
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
        try {
          const records = pt.todos.list();
          const links = records.flatMap((r) => pt.links.findByTodo(r.id));
          const blocking = records.flatMap((r) => pt.links.findBlocking(r.id));
          const { nodesByPath, framesByPath } = buildPathIndices(nodes);
          const todos = buildAdaptedTodos(records, links, blocking, nodesByPath, framesByPath);
          respond(res, TodosResponseSchema, { version: CONTRACT_VERSION, todos }, freshCtx());
        } finally {
          if (resolved?.owned) resolved.store.close();
          pt.close();
        }
        return;
      }

      // ── /api/stories/:id ── (must precede the list route)
      if (pathname.startsWith("/api/stories/")) {
        if (!storiesRepo || !storyStepsRepo) { respondError(res, 503, "stories repos unavailable", cors); return; }
        const idRaw = decodeURIComponent(pathname.slice("/api/stories/".length));
        const idParsed = StoryIdParamSchema.safeParse(idRaw);
        if (!idParsed.success) { respondError(res, 400, "invalid story id", cors); return; }
        const ps = openProjectStories(storiesRepo, storyStepsRepo, indexerProject, project, registry);
        try {
          let rec = ps.stories.get(idParsed.data);
          if (!rec) {
            const ref = parseRef("story", idParsed.data);
            if (ref) rec = ref.kind === "seq" ? ps.stories.getBySeq(ref.seq) : ps.stories.get(ref.id);
          }
          if (!rec) { respondError(res, 404, "story not found", cors); return; }
          const story = buildAdaptedStoryDetail(rec, ps.steps.listByStory(rec.id));
          respond(res, StoryDetailResponseSchema, { version: CONTRACT_VERSION, story }, freshCtx());
        } finally {
          ps.close();
        }
        return;
      }

      // ── /api/stories ──
      if (pathname === "/api/stories") {
        if (!storiesRepo || !storyStepsRepo) { respondError(res, 503, "stories repos unavailable", cors); return; }
        const ps = openProjectStories(storiesRepo, storyStepsRepo, indexerProject, project, registry);
        try {
          const counts = ps.stories.stepCounts();
          const stories = ps.stories.list().map((rec) => buildAdaptedStory(rec, counts.get(rec.id) ?? 0));
          respond(res, StoriesResponseSchema, { version: CONTRACT_VERSION, stories }, freshCtx());
        } finally {
          ps.close();
        }
        return;
      }

      // ── /api/aggregates ── (positionAggregates + buildFrameMap are ALREADY imported;
      // do NOT switch to groupAuxiliaryPaths — that drops the x/y the viewer renders.)
      if (pathname === "/api/aggregates") {
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
        try {
          const edges = resolved ? resolved.store.getAllEdgesUnified(project ?? undefined) : [];
          const frameMap = buildFrameMap(nodes, edges);
          const aggregates = positionAggregates(nodes, edges, frameMap);
          respond(res, AggregatesResponseSchema, { version: CONTRACT_VERSION, aggregates }, freshCtx());
        } finally {
          if (resolved?.owned) resolved.store.close();
        }
        return;
      }

      // ── /api/frames ──
      if (pathname === "/api/frames") {
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        if (!resolved) {
          respond(res, FramesResponseSchema, { version: CONTRACT_VERSION, frames: [], stage: { w: STAGE_W, h: STAGE_H } }, freshCtx());
          return;
        }
        try {
          const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
          const edges = resolved.store.getAllEdgesUnified(project ?? undefined);
          const map = buildFrameMap(nodes, edges);
          respond(res, FramesResponseSchema, { version: CONTRACT_VERSION, ...map }, freshCtx());
        } finally {
          if (resolved.owned) resolved.store.close();
        }
        return;
      }

      // ── /api/file-edges ──
      if (pathname === "/api/file-edges") {
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        if (!resolved) {
          respond(res, FileEdgesResponseSchema, { version: CONTRACT_VERSION, file_edges: [] }, freshCtx());
          return;
        }
        try {
          const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
          const edges = resolved.store.getAllEdgesUnified(project ?? undefined);
          const file_edges = buildFileEdges(nodes, edges, { relations: ["CALLS", "USAGE", "IMPORTS"] });
          respond(res, FileEdgesResponseSchema, { version: CONTRACT_VERSION, file_edges }, freshCtx());
        } finally {
          if (resolved.owned) resolved.store.close();
        }
        return;
      }

      // ── static viewer (traversal-safe) ──
      if (pathname === "/" || pathname.startsWith("/viewer")) {
        const rel = (pathname === "/" || pathname === "/viewer" || pathname === "/viewer/")
          ? "index.html"
          : pathname.replace(/^\/viewer\//, "");
        const filePath = safeStaticPath(VIEWER_DIR, rel);
        if (!filePath) { respondError(res, 404, "not found", cors); return; }
        try {
          const content = await readFile(filePath);
          const ext = extname(filePath);
          // HTML (index.html, served at "/" and "/viewer") is tiny and must
          // revalidate every load — browsers otherwise heuristically cache it,
          // and a stale index.html references content-hashed assets from a
          // build that no longer exists on disk (404 → blank page that never
          // boots). Hashed assets under /assets/ are immutable by construction
          // (Vite renames on every content change), so cache them for a year.
          const cacheControl = ext === ".html"
            ? "no-cache"
            : filePath.includes(`${sep}assets${sep}`)
              ? "public, max-age=31536000, immutable"
              : "no-cache";
          res.writeHead(200, {
            "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
            "Cache-Control": cacheControl,
            ...SECURITY_HEADERS,
            ...cors,
          });
          res.end(content);
        } catch {
          respondError(res, 404, "not found", cors);
        }
        return;
      }

      res.writeHead(302, { Location: "/viewer", ...cors });
      res.end();
    });

    httpServer.requestTimeout = 30_000;   // ms — whole-request ceiling
    httpServer.headersTimeout = 35_000;   // ms — must exceed requestTimeout

    const port = parseInt(process.env.CORTEX_VIEWER_PORT || "3333", 10);
    const log = (msg: string) => process.stderr.write(msg + "\n");

    // One bind attempt over the shared httpServer. listen() is retryable after
    // an 'error' (the server isn't closed by a failed bind), so each attempt
    // wires fresh one-shot listeners and re-issues listen(port).
    const attempt = (): Promise<BindOutcome> =>
      new Promise((res) => {
        const onError = (err: NodeJS.ErrnoException) => {
          httpServer.removeListener("listening", onListening);
          res({ ok: false, error: err });
        };
        const onListening = () => {
          httpServer.removeListener("error", onError);
          res({ ok: true });
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, resolveBindHost(process.env));
      });

    void bindWithRetry(attempt, { port, retries: VIEWER_BIND_RETRIES, delayMs: VIEWER_BIND_DELAY_MS, log })
      .then((ok) => {
        if (ok) {
          const addr = httpServer.address();
          const actualPort = addr && typeof addr === "object" ? addr.port : port;
          resolve({
            port: actualPort,
            httpServer,
            close() {
              httpServer.close();
              registry.close();
            },
          });
        } else {
          // bindWithRetry has already logged WHY. Caller (src/index.ts) logs the
          // user-facing "viewer disabled" line off the port: -1 sentinel.
          resolve({
            port: -1,
            httpServer: null,
            close() {
              registry.close();
            },
          });
        }
      });
  });
}

export function buildPathIndices(nodes: ReturnType<GraphStore["getAllNodesUnified"]>): {
  nodesByPath: Map<string, ReturnType<GraphStore["getAllNodesUnified"]>[number]>;
  framesByPath: Map<string, FrameInfo>;
} {
  const nodesByPath = new Map<string, ReturnType<GraphStore["getAllNodesUnified"]>[number]>();
  const framesByPath = new Map<string, FrameInfo>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    nodesByPath.set(n.file_path, n);
    if (!n.data) continue;
    try {
      const data = JSON.parse(n.data) as { frame_id?: number; frame_label?: string };
      if (typeof data.frame_id === "number" && typeof data.frame_label === "string") {
        framesByPath.set(n.file_path, { frame_id: data.frame_id, frame_label: data.frame_label });
      }
    } catch {
      /* ignore parse failures */
    }
  }
  return { nodesByPath, framesByPath };
}
