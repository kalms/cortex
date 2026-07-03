import { useEffect, useRef } from "react";
import { useUiStore } from "../ui-store";
import { push, openReplace } from "./drawer-stack";
import { listRows } from "./selectors";

const TABS = ["all", "decisions", "todos"] as const;

// Module-level scroll position — intentionally survives view swaps within the
// session (a row view pushes onto the stack, so popping back re-renders the
// list fresh; this restores where the user left off instead of resetting to
// the top). Per-tab granularity is not required.
let listScrollTop = 0;

export function ListView({ tab }: { tab: "all" | "decisions" | "todos" }) {
  const bundle = useUiStore((s) => s.bundle);
  const set = useUiStore((s) => s.set);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = listScrollTop;
  }, []);

  if (!bundle) return null;
  const rows = listRows(bundle, tab);
  return (<>
    <div className="dc-header"><div className="dc-id-block">
      <div className="dc-id-row"><span className="dc-id">records</span></div>
      <div className="dc-list-tabs">{TABS.map((t) => (
        <button key={t} className={`dc-list-tab${t === tab ? " active" : ""}`}
          onClick={() => set({ drawerStack: openReplace([], { kind: "list", tab: t }) })}>{t}</button>))}
      </div>
    </div></div>
    <div className="dc-body dc-list-body" ref={bodyRef}
      onScroll={(e) => { listScrollTop = e.currentTarget.scrollTop; }}>
      {rows.map((r) => (
        <div key={`${r.type}:${r.id}`} className={`dc-list-row${r.closed ? " closed" : ""}`}
          onClick={() => set({ drawerStack: push(useUiStore.getState().drawerStack,
            { kind: "record", type: r.type, id: r.id }) })}>
          <span className={`dc-list-dot ${r.type} ${r.state}`} />
          <span className="dc-list-id">{r.displayId}</span>
          <span className="dc-list-title">{r.title}</span>
          <span className="dc-list-date">{r.date}</span>
        </div>))}
      {rows.length === 0 && <div className="dc-list-empty">no records</div>}
    </div>
  </>);
}
