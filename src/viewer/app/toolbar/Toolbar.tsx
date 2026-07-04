import { useUiStore } from "../ui-store";
import { LayersMenu } from "./LayersMenu";
import { ProjectSelect } from "./ProjectSelect";

export function Toolbar() {
  const theme = useUiStore((s) => s.theme);
  const set = useUiStore((s) => s.set);

  return (
    <div className="toolbar">
      <ProjectSelect />
      <button id="palette-btn" title="Search (⌘K)"
        onClick={() => set({ paletteOpen: true })}>
        <span className="pb-glyph">⌕</span><span className="pb-hint">⌘K</span>
      </button>
      <button id="records-toggle" title="Records"
        onClick={() => set({ drawerStack: [{ kind: "list", tab: "all" }] })}>
        records
      </button>
      <LayersMenu />
      <button id="theme-toggle" title="Toggle light/dark"
        onClick={() => set({ theme: theme === "light" ? "dark" : "light" })}>
        ◐
      </button>
    </div>
  );
}
