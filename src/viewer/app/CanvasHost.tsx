import { useEffect, useRef } from "react";
import { createEngine } from "../canvas/engine.js";
import { createStore } from "./entity-store.js";
import { connectLiveSync } from "./ws-client.js";
import { fetchProjects } from "./api";
import { loadProject, resyncProject } from "./data";
import { useUiStore } from "./ui-store";
import { frameCoverage } from "../canvas/adapters.js";

export const entityStore = createStore();     // module singleton (decisions/todos)
export let engineRef: ReturnType<typeof createEngine> | null = null;

// Replayed backfill events older than this are dropped rather than re-applied
// on reconnect (the client re-sends backfill on every hello — see ws-client.js).
const BACKFILL_WINDOW_MS = 1_800_000;

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
      },
    });
    engineRef = engine;
    set({ layerPrefs: engine.getLayerPrefs() });

    let currentProject: string | null = null;
    let lastKnownHead: string | null = null;

    async function boot() {
      const { projects, active } = await fetchProjects();
      currentProject = active;
      set({ projects, activeProject: active });
      const bundle = await loadProject(active);
      // `as any`: entity-store.js is plain JS; TS narrows its `cursor = null`
      // default to `null | undefined`, but the store accepts a ULID string.
      entityStore.hydrate({ decisions: bundle.decisionMap, todos: bundle.ambientTodoMap,
        cursor: (currentProject === sync.boundProject ? lastKnownHead : null) as any });
      engine.setData(bundle);
      set({ bundle });
      applyFramesWarning(bundle);
      engine.start();
    }

    const sync = connectLiveSync({
      wsUrl: `ws://${location.host}/ws`,
      store: entityStore,
      isLiveProject: () => currentProject === sync.boundProject,
      resnapshot: async (headUlid: string) => {
        lastKnownHead = headUlid ?? lastKnownHead;
        const prev = useUiStore.getState().bundle;
        if (!prev) return;
        const bundle = await resyncProject(currentProject, prev);
        entityStore.hydrate({ decisions: bundle.decisionMap, todos: bundle.ambientTodoMap, cursor: (headUlid ?? null) as any });
        engine.setData(bundle, { preserveFocus: true });
        useUiStore.getState().set({ bundle });
      },
      onStatus: (s: string) => useUiStore.getState().set({
        syncStatus: s, syncVisible: currentProject === sync.boundProject }),
      eventBackfill: { limit: 200 },
      onEvent: (event: any, meta: { live: boolean }) => {
        if (event?.kind !== "presence.activity") return;
        if (!meta.live && event.created_at < Date.now() - BACKFILL_WINDOW_MS) return;
        engine.applyPresence([{ payload: event.payload, live: meta.live }]);
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
        currentProject = s.activeProject;
        const bundle = await loadProject(currentProject);
        entityStore.hydrate({ decisions: bundle.decisionMap, todos: bundle.ambientTodoMap,
          cursor: (currentProject === sync.boundProject ? lastKnownHead : null) as any });
        engine.setData(bundle);
        useUiStore.getState().set({ bundle, drawerStack: [], focusedFrameId: null,
          syncVisible: currentProject === sync.boundProject });
        applyFramesWarning(bundle);
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
