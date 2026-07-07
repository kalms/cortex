import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../ui-store";
import { push, openReplace } from "./drawer-stack";
import { listRows } from "./selectors";
import { formatRelativeDate } from "../display";

const TABS = ["all", "decisions", "todos"] as const;

// Module-level scroll position — intentionally survives view swaps within the
// session (a row view pushes onto the stack, so popping back re-renders the
// list fresh; this restores where the user left off instead of resetting to
// the top). Per-tab granularity is not required.
let listScrollTop = 0;

export function ListView({ tab, frameId }: { tab: "all" | "decisions" | "todos"; frameId?: string }) {
  const bundle = useUiStore((s) => s.bundle);
  const set = useUiStore((s) => s.set);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = listScrollTop;
    // Take focus on open: mount effects run after the palette's focus-restore
    // cleanup, so arrows navigate the list instead of the restored opener
    // control (e.g. the project-select combobox, which claims ArrowDown).
    bodyRef.current?.focus({ preventScroll: true });
  }, []);

  // Memoized: sel changes re-render on every arrow key / row hover, and the
  // frame-scoped filter walks every record's governs refs.
  const rows = useMemo(() => (bundle ? listRows(bundle, tab, frameId) : []), [bundle, tab, frameId]);
  // Rows shrink when switching tabs or on live updates; keep sel in range.
  const selIdx = Math.min(sel, Math.max(0, rows.length - 1));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selRef = useRef(selIdx);
  selRef.current = selIdx;

  // Window-level so the list is arrow-navigable straight from the palette /
  // records button without first clicking into the drawer. defaultPrevented
  // skips keys already claimed by the palette or an open toolbar dropdown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useUiStore.getState().paletteOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const n = rowsRef.current.length;
      if (!n) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(selRef.current + 1, n - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(selRef.current - 1, 0)); }
      else if (e.key === "Home") { e.preventDefault(); setSel(0); }
      else if (e.key === "End") { e.preventDefault(); setSel(n - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const r = rowsRef.current[selRef.current];
        if (r) set({ drawerStack: push(useUiStore.getState().drawerStack, { kind: "record", type: r.type, id: r.id }) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  useEffect(() => {
    bodyRef.current?.querySelector(".dc-list-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  if (!bundle) return null;
  // frameMeta is the canonical id → name index (covers frames the x!==null
  // render filter dropped); bundle.frames would miss those.
  const frameName = frameId
    ? (bundle.frameMeta?.get?.(frameId)?.name ?? frameId)
    : null;
  return (<>
    <div className="dc-header"><div className="dc-id-block">
      <div className="dc-id-row">
        <span className="dc-id">records</span>
        {frameName && <span className="dc-id dc-list-frame" title="scoped to frame">· {frameName}</span>}
        {frameName && <button className="dc-scope-clear" aria-label="clear frame filter" title="clear frame filter"
          onClick={() => set({ drawerStack: openReplace([], { kind: "list", tab }) })}>×</button>}
      </div>
      <div className="dc-list-tabs">{TABS.map((t) => (
        <button key={t} className={`dc-list-tab${t === tab ? " active" : ""}`}
          onClick={() => set({ drawerStack: openReplace([], { kind: "list", tab: t, frameId }) })}>{t}</button>))}
      </div>
    </div></div>
    <div className="dc-body dc-list-body" ref={bodyRef} tabIndex={-1}
      onScroll={(e) => { listScrollTop = e.currentTarget.scrollTop; }}>
      {rows.map((r, i) => (
        <div key={`${r.type}:${r.id}`}
          className={`dc-list-row${r.closed ? " closed" : ""}${i === selIdx ? " selected" : ""}`}
          onMouseEnter={() => setSel(i)}
          onClick={() => set({ drawerStack: push(useUiStore.getState().drawerStack,
            { kind: "record", type: r.type, id: r.id }) })}>
          <span className={`dc-list-dot ${r.type} ${r.state}`} />
          <span className="dc-list-id">{r.displayId}</span>
          <span className="dc-list-title">{r.title}</span>
          <span className="dc-list-date">{formatRelativeDate(r.date)}</span>
        </div>))}
      {rows.length === 0 && <div className="dc-list-empty">no records</div>}
    </div>
  </>);
}
