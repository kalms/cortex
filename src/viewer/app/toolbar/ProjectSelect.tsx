import { useState, useRef, useEffect } from "react";
import { useUiStore } from "../ui-store";
import { projectDisplayName, checkoutLabel } from "../display";

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
      // Enter/Space open through the button's native click → onClick → openMenu.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Tab") setOpen(false);
    else if (!projects.length) return;
    else if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, projects.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Home") { e.preventDefault(); setFocusIdx(0); }
    else if (e.key === "End") { e.preventDefault(); setFocusIdx(projects.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (projects[focusIdx]) choose(projects[focusIdx].name); }
  };

  return (
    <div className="project-select-wrap" ref={rootRef} onKeyDown={onKeyDown}>
      <button id="project-select" className="project-select-btn" title="Project"
        // AT only tracks aria-activedescendant on composite roles, not button —
        // this is the APG select-only combobox pattern.
        role="combobox" aria-haspopup="listbox" aria-expanded={open}
        aria-controls="project-select-listbox"
        aria-activedescendant={open && projects[focusIdx] ? `ps-opt-${focusIdx}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}>
        <span className="ps-btn-label">
          {active ? checkoutLabel({ name: projectDisplayName(active), branch: active.branch }) : "(no projects)"}
        </span>
        <span className="ps-caret">▾</span>
      </button>
      {open && (
        <div className="project-select-menu" id="project-select-listbox" role="listbox" aria-label="Projects"
          // Keep focus on the button: a mousedown on menu padding would blur to
          // <body> and strand the menu open with keyboard handling dead.
          onMouseDown={(e) => e.preventDefault()}>
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
