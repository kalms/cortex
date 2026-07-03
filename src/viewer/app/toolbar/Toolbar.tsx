import { useUiStore } from "../ui-store";
import { LayersMenu } from "./LayersMenu";

export function Toolbar() {
  const syncStatus = useUiStore((s) => s.syncStatus);
  const syncVisible = useUiStore((s) => s.syncVisible);
  const projects = useUiStore((s) => s.projects);
  const activeProject = useUiStore((s) => s.activeProject);
  const theme = useUiStore((s) => s.theme);
  const set = useUiStore((s) => s.set);

  return (
    <div className="toolbar">
      <span id="sync-indicator" className={`sync-indicator ${syncStatus}`} hidden={!syncVisible}>
        <i className="dot" /><span className="word">{syncStatus}</span>
      </span>
      <select id="project-select" title="Project" value={activeProject ?? ""}
        onChange={(e) => set({ activeProject: e.target.value || null })}>
        {projects.length === 0 ? (
          <option value="" disabled>(no projects)</option>
        ) : (
          projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)
        )}
      </select>
      <LayersMenu />
      <button id="theme-toggle" title="Toggle light/dark"
        onClick={() => set({ theme: theme === "light" ? "dark" : "light" })}>
        ◐
      </button>
    </div>
  );
}
