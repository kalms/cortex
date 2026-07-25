import { useEffect, useRef } from "react";
import { createEngine } from "../canvas/engine.js";
import { createStore } from "./entity-store.js";
import { connectLiveSync } from "./ws-client.js";
import { fetchProjects } from "./api";
import { loadProject, resyncProject } from "./data";
import { useUiStore } from "./ui-store";
import { frameCoverage } from "../canvas/adapters.js";
import { handleAdvanceEvent } from "./story/story-controller";

export const entityStore = createStore();     // module singleton (decisions/todos)
export let engineRef: ReturnType<typeof createEngine> | null = null;

// Replayed backfill events older than this are dropped rather than re-applied
// on reconnect (the client re-sends backfill on every hello — see ws-client.js).
const BACKFILL_WINDOW_MS = 1_800_000;

// Hard cap on the presence-event buffer held while frames aren't ready yet.
// A stalled HTTP boot combined with a flapping WS (backfill re-sends up to
// eventBackfill.limit events on every reconnect) could otherwise grow this
// buffer without bound. Drop-oldest on overflow — newer presence beats stale.
const PENDING_PRESENCE_CAP = 400;

function applyFramesWarning(bundle: any) {
  const { zeroFrames, fileNodes } = frameCoverage(bundle.rawNodes);
  useUiStore.getState().set({ framesWarning: zeroFrames
    ? `${fileNodes} files indexed, 0 frames — reindex via cortex index to generate frames.`
    : null });
}

export function CanvasHost() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const set = useUiStore.getState().set;
    const engine = createEngine({
      canvas: canvasRef.current!, store: entityStore,
      callbacks: {
        onFrameFocus: (id: string | null) => set({ focusedFrameId: id }),
        onRecordClick: (type: string, id: string) =>
          set({ drawerStack: [{ kind: "record", type: type as any, id }] }),
        onRecordDismiss: () => set({ drawerStack: [] }),
        onFileClick: ({ filePath }: { filePath: string }) =>
          set({ drawerStack: [{ kind: "record", type: "file", id: filePath }] }),
        onViewAll: (frameId: string, tab: "decisions" | "todos") =>
          set({ drawerStack: [{ kind: "list", tab, frameId }] }),
        onPresenceRoster: (roster: any) => set({ presenceRoster: roster }),
        onSpotlight: (p: any) => set({ spotlight: p }),
      },
    });
    engineRef = engine;
    set({ layerPrefs: engine.getLayerPrefs() });

    let currentProject: string | null = null;
    let lastKnownHead: string | null = null;

    // Presence events (live or backfilled) can arrive on the WS `hello`/backfill
    // round-trip before boot()'s awaited HTTP fetches populate the engine's frame
    // index. applyPresence resolves refs→frames eagerly, so any event applied
    // before setData resolves to an empty frame set — leaving the session in the
    // roster but with no canvas heat/dot, permanently (no re-resolution). Buffer
    // until the engine has data, then flush in arrival order.
    let framesReady = false;
    // Monotonic load token. Each async loader (boot, resnapshot, project switch)
    // increments it synchronously on entry and captures the value; after every
    // await it abandons its continuation if the token has advanced — i.e. a newer
    // loader has taken over. Without this, a loader for project A resolving after
    // a switch to B has begun would re-arm framesReady and hydrate stale data
    // against B's frame index (and flash A's bundle). The latest loader wins.
    let loadEpoch = 0;
    const pendingPresence: Array<[any, { live: boolean }]> = [];
    function applyPresenceEvent(event: any, meta: { live: boolean }) {
      if (event?.kind !== "presence.activity") return;
      if (!meta.live && event.created_at < Date.now() - BACKFILL_WINDOW_MS) return;
      engine.applyPresence([{ payload: event.payload, live: meta.live }]);
    }
    function bufferPresence(event: any, meta: { live: boolean }) {
      pendingPresence.push([event, meta]);
      if (pendingPresence.length > PENDING_PRESENCE_CAP) pendingPresence.shift();
    }
    // Shared by boot() and the project-switch handler: mark the engine's frame
    // index ready, then drain whatever presence events queued up while it wasn't.
    function armFramesReady() {
      framesReady = true;
      for (const [event, meta] of pendingPresence.splice(0)) applyPresenceEvent(event, meta);
    }

    async function boot() {
      const epoch = ++loadEpoch;
      const { projects, active } = await fetchProjects();
      if (epoch !== loadEpoch) return;
      currentProject = active;
      set({ projects, activeProject: active });
      const bundle = await loadProject(active);
      if (epoch !== loadEpoch) return;
      // `as any`: entity-store.js is plain JS; TS narrows its `cursor = null`
      // default to `null | undefined`, but the store accepts a ULID string.
      entityStore.hydrate({ decisions: bundle.decisionMap, todos: bundle.ambientTodoMap,
        cursor: (currentProject === sync.boundProject ? lastKnownHead : null) as any });
      engine.setData(bundle);
      set({ bundle });
      applyFramesWarning(bundle);
      engine.start();
      armFramesReady();
    }

    // Shared by the `isLiveProject` callback below and by onEvent — ws-client
    // filters `projection` deltas by this, but NOT `event` messages (presence
    // backfill/live events are sent regardless of which project is bound), so
    // CanvasHost has to apply the same guard itself before touching the engine.
    const isLiveProject = () => currentProject === sync.boundProject;

    const sync = connectLiveSync({
      wsUrl: `ws://${location.host}/ws`,
      store: entityStore,
      isLiveProject,
      resnapshot: async (headUlid: string) => {
        lastKnownHead = headUlid ?? lastKnownHead;
        const prev = useUiStore.getState().bundle;
        if (!prev) return;
        const epoch = ++loadEpoch;
        // Same-project resync: re-arm the frame gate around it too, since the
        // frame index is briefly stale mid-resync (ws-client doesn't pause
        // `event` delivery for this — only `projection` deltas are buffered).
        framesReady = false;
        pendingPresence.length = 0;
        const bundle = await resyncProject(currentProject, prev);
        if (epoch !== loadEpoch) return;
        entityStore.hydrate({ decisions: bundle.decisionMap, todos: bundle.ambientTodoMap, cursor: (headUlid ?? null) as any });
        engine.setData(bundle, { preserveFocus: true });
        useUiStore.getState().set({ bundle });
        armFramesReady();
      },
      onStatus: (s: string) => useUiStore.getState().set({
        syncStatus: s, syncVisible: currentProject === sync.boundProject }),
      eventBackfill: { limit: 200 },
      onEvent: (event: any, meta: { live: boolean }) => {
        if (event?.kind === "show.focus") {
          if (!meta.live) return;                                  // spotlight is live-only — never from backfill
          if (currentProject !== null && !isLiveProject()) return; // same cross-project drop as presence
          if (!framesReady) return;                                // pre-boot focus is meaningless; agent re-issues
          engine.applySpotlight(event.payload ?? { refs: [] });
          return;
        }
        if (event?.kind === "show.advance") {
          if (!meta.live) return;                                  // live-only, like show.focus
          if (currentProject !== null && !isLiveProject()) return; // same cross-project drop as presence
          if (!framesReady) return;                                // pre-boot advance is meaningless; agent re-issues
          void handleAdvanceEvent(event.payload?.story_id, event.payload?.step ?? 1);
          return;
        }
        if (event?.kind !== "presence.activity") return;
        // ws-client doesn't filter `event` messages by project (see isLiveProject
        // comment above) — drop anything not for the currently-bound project so
        // a background project's presence can't be misapplied onto this one.
        // Exception: pre-boot (`currentProject === null`, until fetchProjects
        // resolves) isLiveProject() is false but `sync.boundProject` is already
        // set from `hello`, so the drop would silently lose every event in that
        // window. Buffer instead — boot() flushes once the frame index lands.
        // The drop only applies once we actually know the active project.
        if (currentProject !== null && !isLiveProject()) return;
        // Hold until the engine's frame index exists (see framesReady above),
        // otherwise refs resolve to nothing and the session never gets a dot.
        if (!framesReady) { bufferPresence(event, meta); return; }
        applyPresenceEvent(event, meta);
      },
    });

    const unsub = entityStore.subscribe((changes: any[]) => {
      engine.applyLiveChanges(changes);
      // removed-while-open snapshot: Drawer renders prev when the open record vanishes
      const { drawerStack, removedSnapshots, set } = useUiStore.getState();
      const top = drawerStack[drawerStack.length - 1];
      for (const c of changes) {
        if (c.op === "remove" && c.prev && top?.kind === "record" && top.id === c.id) {
          set({ removedSnapshots: { ...removedSnapshots, [c.id]: c.prev } });
        }
      }
    });

    // project switching: subscribe to activeProject changes
    const unsubProject = useUiStore.subscribe(async (s, prevS) => {
      if (s.activeProject !== prevS.activeProject && s.activeProject !== currentProject) {
        const epoch = ++loadEpoch;
        // Re-arm the frame gate around the switch: the old frame index is gone
        // the instant currentProject flips, so anything queued for the prior
        // project (or arriving mid-await, now guarded by isLiveProject too) must
        // not be replayed against it — drop the buffer and re-latch until the
        // new bundle lands.
        framesReady = false;
        pendingPresence.length = 0;
        currentProject = s.activeProject;
        const bundle = await loadProject(currentProject);
        if (epoch !== loadEpoch) return;
        entityStore.hydrate({ decisions: bundle.decisionMap, todos: bundle.ambientTodoMap,
          cursor: (currentProject === sync.boundProject ? lastKnownHead : null) as any });
        engine.setData(bundle);
        useUiStore.getState().set({ bundle, drawerStack: [], focusedFrameId: null, story: null,
          stories: [], syncVisible: currentProject === sync.boundProject });
        applyFramesWarning(bundle);
        armFramesReady();
      }
    });

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    boot();
    return () => { unsub(); unsubProject(); window.removeEventListener("resize", onResize);
      sync.close(); engine.destroy(); engineRef = null; };
  }, []);
  return <canvas id="stage" ref={canvasRef} />;
}
