import { useState, useRef, useEffect } from "react";
import { useUiStore } from "../ui-store";
import { projectDisplayName } from "../display";

export function ProjectSelect() {
  const { projects, activeProject, set } = useUiStore((s) => ({
    projects: s.projects, activeProject: s.activeProject, set: s.set }));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (open && rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  const active = projects.find((p) => p.name === activeProject) ?? null;
  return (
    <div className="project-select-wrap" ref={rootRef}>
      <button id="project-select" className="project-select-btn" title="Project"
        aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {active ? projectDisplayName(active) : "(no projects)"}
        <span className="ps-caret">▾</span>
      </button>
      {open && (
        <div className="project-select-menu" role="listbox">
          {projects.map((p) => (
            <div key={p.name} role="option" aria-selected={p.name === activeProject}
              className={`ps-item${p.name === activeProject ? " active" : ""}`}
              onClick={() => { setOpen(false); set({ activeProject: p.name }); }}>
              <div className="ps-name">{projectDisplayName(p)}</div>
              <div className="ps-path">{p.root_path}</div>
            </div>
          ))}
          {projects.length === 0 && <div className="ps-empty">(no projects)</div>}
        </div>
      )}
    </div>
  );
}
