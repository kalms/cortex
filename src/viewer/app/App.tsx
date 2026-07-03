import { useEffect } from "react";
import { CanvasHost, engineRef } from "./CanvasHost";
import { Toolbar } from "./toolbar/Toolbar";
import { Drawer } from "./drawer/Drawer";
import { Palette } from "./palette/Palette";
import { LS_KEYS, useUiStore } from "./ui-store";

export function App() {
  const theme = useUiStore((s) => s.theme);
  const layerPrefs = useUiStore((s) => s.layerPrefs);
  const drawerStack = useUiStore((s) => s.drawerStack);
  const framesWarning = useUiStore((s) => s.framesWarning);

  useEffect(() => { document.body.classList.toggle("light", theme === "light"); }, [theme]);
  useEffect(() => {
    engineRef?.setLayerPrefs(layerPrefs);
    try {
      localStorage.setItem(LS_KEYS.layers, layerPrefs.layerTint ? "1" : "0");
      localStorage.setItem(LS_KEYS.frames, layerPrefs.showFrames ? "1" : "0");
      localStorage.setItem(LS_KEYS.decisions, layerPrefs.showDecisions ? "1" : "0");
      localStorage.setItem(LS_KEYS.todos, layerPrefs.showTodos ? "1" : "0");
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
      if (e.key !== "Escape") return;
      const { drawerStack, paletteOpen, set } = useUiStore.getState();
      if (paletteOpen) return;                    // palette handles its own Esc
      if (drawerStack.length) set({ drawerStack: [] });
      else engineRef?.focusFrame(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (<>
    <CanvasHost />
    <Toolbar />
    <Drawer />
    <Palette />
    {framesWarning && <div className="frames-warning" id="frames-warning">
      <span className="frames-warning-text">
        {framesWarning.split("cortex index")[0]}
        <code>cortex index</code>
        {framesWarning.split("cortex index")[1]}
      </span>
      <button className="frames-warning-dismiss" aria-label="Dismiss"
        onClick={() => useUiStore.getState().set({ framesWarning: null })}>×</button>
    </div>}
    <div className="logo-mark"><div className="word">cortex</div></div>
  </>);
}
