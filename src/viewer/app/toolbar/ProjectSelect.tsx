import { useState, useRef, useEffect } from "react";
import { useUiStore } from "../ui-store";
import { projectDisplayName } from "../display";

export function ProjectSelect() {
  const projects = useUiStore((s) => s.projects);
  const activeProject = useUiStore((s) => s.activeProject);
  const set = useUiStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (open && rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  const active = projects.find((p) => p.name === activeProject) ?? null;

  const openMenu = () => {
    const i = projects.findIndex((p) => p.name === activeProject);
    setFocusIdx(i >= 0 ? i : 0);
    setOpen(true);
  };
  const choose = (name: string) => { setOpen(false); set({ activeProject: name }); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      // preventDefault also suppresses the button's native Enter/Space click,
      // so openMenu is the single open path and the toggle can't double-fire.
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, projects.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Home") { e.preventDefault(); setFocusIdx(0); }
    else if (e.key === "End") { e.preventDefault(); setFocusIdx(projects.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (projects[focusIdx]) choose(projects[focusIdx].name); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="project-select-wrap" ref={rootRef} onKeyDown={onKeyDown}>
      <button id="project-select" className="project-select-btn" title="Project"
        aria-haspopup="listbox" aria-expanded={open}
        aria-activedescendant={open && projects[focusIdx] ? `ps-opt-${focusIdx}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}>
        {active ? projectDisplayName(active) : "(no projects)"}
        <span className="ps-caret">▾</span>
      </button>
      {open && (
        <div className="project-select-menu" role="listbox" aria-label="Projects">
          {projects.map((p, i) => (
            <div key={p.name} id={`ps-opt-${i}`} role="option" aria-selected={p.name === activeProject}
              className={`ps-item${p.name === activeProject ? " active" : ""}${i === focusIdx ? " focused" : ""}`}
              onMouseEnter={() => setFocusIdx(i)}
              onClick={() => choose(p.name)}>
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
