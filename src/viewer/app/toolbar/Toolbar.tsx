import { useUiStore } from "../ui-store";
import { LayersMenu } from "./LayersMenu";
import { ProjectSelect } from "./ProjectSelect";

export function Toolbar() {
  const syncStatus = useUiStore((s) => s.syncStatus);
  const syncVisible = useUiStore((s) => s.syncVisible);
  const theme = useUiStore((s) => s.theme);
  const set = useUiStore((s) => s.set);

  return (
    <div className="toolbar">
      <span id="sync-indicator" className={`sync-indicator ${syncStatus}`} hidden={!syncVisible}>
        <i className="dot" /><span className="word">{syncStatus}</span>
      </span>
      <ProjectSelect />
      <LayersMenu />
      <button id="theme-toggle" title="Toggle light/dark"
        onClick={() => set({ theme: theme === "light" ? "dark" : "light" })}>
        ◐
      </button>
    </div>
  );
}
