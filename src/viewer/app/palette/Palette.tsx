import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../ui-store";
import { buildSearchIndex, searchIndex, type IndexEntry } from "./search-index";
import { buildActions } from "./actions";
import { fuzzyScore } from "./fuzzy";
import { engineRef } from "../CanvasHost";

export function Palette() {
  const open = useUiStore((s) => s.paletteOpen);
  const bundle = useUiStore((s) => s.bundle);
  const projects = useUiStore((s) => s.projects);
  const activeProject = useUiStore((s) => s.activeProject);
  const layerPrefs = useUiStore((s) => s.layerPrefs);
  const set = useUiStore((s) => s.set);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => (bundle ? buildSearchIndex(bundle, projects) : []), [bundle, projects]);
  // Own memo so a fresh-array-per-render `actions` doesn't defeat the `groups`
  // memo below — actions only need to change when the ingredients they're
  // built from change. `set`/`toggleTheme` are stable via the getState
  // pattern, so they're deliberately left out of the dep list.
  const actions = useMemo(
    () => buildActions({
      projects, activeProject, layerPrefs, set,
      toggleTheme: () => set({ theme: useUiStore.getState().theme === "light" ? "dark" : "light" }),
    }),
    [projects, activeProject, layerPrefs],
  );

  const groups: IndexEntry[][] = useMemo(() => {
    const matchedActions = actions
      .map((e) => ({ e, s: fuzzyScore(query, e.haystack) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.e);
    if (!query) {
      // resting state: actions + top frames
      const frames = entries.filter((e) => e.group === "frames").slice(0, 5);
      return [matchedActions, frames].filter((g) => g.length);
    }
    const rest = searchIndex(entries, query, 5);
    return [matchedActions, ...rest].filter((g) => g.length);
  }, [query, entries, actions]);
  const flat = groups.flat();

  useEffect(() => { if (open) { setQuery(""); setSel(0); inputRef.current?.focus(); } }, [open]);
  useEffect(() => { setSel(0); }, [query]);
  useEffect(() => {
    resultsRef.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  // Focus trap: window-level (capture) because clicking the results area blurs
  // the input to <body>, so a handler on the palette div would never see the Tab.
  useEffect(() => {
    if (!open) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = rootRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusables.length) { e.preventDefault(); return; }
      const first = focusables[0], last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, [open]);
  if (!open) return null;

  const execute = (e: IndexEntry) => {
    set({ paletteOpen: false });
    const r = e.ref;
    if (r.kind === "action") return r.run();
    if (r.kind === "frame") return engineRef?.focusFrame(r.id);
    if (r.kind === "file") {
      const fid = engineRef?.frameIdForFilePath(r.path);
      if (fid) engineRef?.focusFrame(fid);
      return set({ drawerStack: [{ kind: "record", type: "file", id: r.path }] });
    }
    if (r.kind === "symbol")
      return set({ drawerStack: [{ kind: "record", type: "file", id: r.path, symbol: r.name }] });
    if (r.kind === "decision" || r.kind === "todo")
      return set({ drawerStack: [{ kind: "record", type: r.kind, id: r.id }] });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); set({ paletteOpen: false }); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => flat.length ? Math.min(s + 1, flat.length - 1) : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && flat[sel]) { e.preventDefault(); execute(flat[sel]); }
  };

  let idx = -1;
  return (
    <div className="palette-overlay" onClick={() => set({ paletteOpen: false })}>
      <div className="palette" ref={rootRef} role="dialog" aria-modal="true" aria-label="Command palette"
        onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-header">JUMP TO</div>
        <div className="palette-input-row">
          <span className="palette-glyph">⌕</span>
          <input ref={inputRef} id="palette-input" aria-label="Search files, symbols, decisions, todos"
            value={query} placeholder="Search files, symbols, decisions, todos…"
            onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="palette-results" ref={resultsRef}>
          {groups.map((g) => (
            <div className="palette-group" key={g[0].group}>
              <div className="palette-group-label">{g[0].group}</div>
              {g.map((e) => { idx++; const i = idx; return (
                <div key={`${e.group}:${e.ref.kind}:${e.ref.id ?? ""}:${e.ref.path ?? ""}:${e.ref.name ?? e.label}`}
                  className={`palette-item${i === sel ? " selected" : ""}`}
                  onMouseEnter={() => setSel(i)} onClick={() => execute(e)}>
                  <span className="palette-item-label">{e.label}</span>
                  <span className="palette-item-sub">{e.sublabel}</span>
                </div>); })}
            </div>))}
          {flat.length === 0 && <div className="palette-empty">no matches</div>}
        </div>
        <div className="palette-footer">
          <span>↑↓ navigate</span><span>⏎ open</span><span>esc dismiss</span>
        </div>
      </div>
    </div>
  );
}
