import { useEffect, useRef } from "react";
import { CanvasHost, engineRef } from "./CanvasHost";
import { Toolbar } from "./toolbar/Toolbar";
import { Drawer } from "./drawer/Drawer";
import { Palette } from "./palette/Palette";
import { SpotlightCard } from "./SpotlightCard";
import { StoryCard } from "./story/StoryCard";
import { closeStory, openStory, pageStory } from "./story/story-controller";
import { LS_KEYS, useUiStore } from "./ui-store";

export function App() {
  const theme = useUiStore((s) => s.theme);
  const layerPrefs = useUiStore((s) => s.layerPrefs);
  const drawerStack = useUiStore((s) => s.drawerStack);
  const framesWarning = useUiStore((s) => s.framesWarning);
  const syncStatus = useUiStore((s) => s.syncStatus);
  const syncVisible = useUiStore((s) => s.syncVisible);
  const bundle = useUiStore((s) => s.bundle);
  const deepLinked = useRef(false);

  useEffect(() => { document.body.classList.toggle("light", theme === "light"); }, [theme]);
  // One-shot deep link: opens a story ONLY when ?story= is present on the
  // first bundle load — the viewer must never auto-open a story otherwise.
  useEffect(() => {
    if (!bundle || deepLinked.current) return;
    deepLinked.current = true;
    const id = new URLSearchParams(location.search).get("story");
    if (id) openStory(id);
  }, [bundle]);
  useEffect(() => {
    engineRef?.setLayerPrefs(layerPrefs);
    try {
      localStorage.setItem(LS_KEYS.layers, layerPrefs.layerTint ? "1" : "0");
      localStorage.setItem(LS_KEYS.frames, layerPrefs.showFrames ? "1" : "0");
      localStorage.setItem(LS_KEYS.decisions, layerPrefs.showDecisions ? "1" : "0");
      localStorage.setItem(LS_KEYS.todos, layerPrefs.showTodos ? "1" : "0");
      localStorage.setItem(LS_KEYS.presence, layerPrefs.showPresence ? "1" : "0");
    } catch { /* sandboxed */ }
  }, [layerPrefs]);
  useEffect(() => {
    const top = drawerStack[drawerStack.length - 1];
    engineRef?.setActiveRecord(top?.kind === "record" && top.type !== "file" ? { type: top.type, id: top.id } : null);
    document.body.classList.toggle("card-open", drawerStack.length > 0);
  }, [drawerStack]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const { set, paletteOpen } = useUiStore.getState();
        set({ paletteOpen: !paletteOpen });
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && useUiStore.getState().story
        && !useUiStore.getState().paletteOpen && useUiStore.getState().drawerStack.length === 0) {
        e.preventDefault();
        pageStory(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (e.key !== "Escape") return;
      const { drawerStack, paletteOpen, set } = useUiStore.getState();
      if (paletteOpen) { set({ paletteOpen: false }); return; }  // close palette when focus escaped it
      if (drawerStack.length) { set({ drawerStack: [] }); return; }
      const { story } = useUiStore.getState();
      if (story) { closeStory(); return; }
      const { spotlight } = useUiStore.getState();
      if (spotlight) { engineRef?.applySpotlight(null); return; }  // onSpotlight(null) clears the store
      engineRef?.focusFrame(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (<>
    <CanvasHost />
    <Toolbar />
    <Drawer />
    <Palette />
    <SpotlightCard />
    <StoryCard />
    {framesWarning && <div className="frames-warning" id="frames-warning">
      <span className="frames-warning-text">
        {framesWarning.split("cortex index")[0]}
        <code>cortex index</code>
        {framesWarning.split("cortex index")[1]}
      </span>
      <button className="frames-warning-dismiss" aria-label="Dismiss"
        onClick={() => useUiStore.getState().set({ framesWarning: null })}>×</button>
    </div>}
    <div className="logo-mark">
      <div className="word">cortex</div>
      <span id="sync-indicator" className={`sync-indicator ${syncStatus}`} hidden={!syncVisible}>
        <i className="dot" /><span className="word">{syncStatus}</span>
      </span>
    </div>
  </>);
}
