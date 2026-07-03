import { useUiStore } from "../ui-store";
import { push } from "./drawer-stack";
import { fileCardData } from "./selectors";
import { RefPill } from "./RefPill";
import { engineRef } from "../CanvasHost";
import { todoDisplayId } from "../display";

export function FileCard({ path, symbol }: { path: string; symbol?: string }) {
  const bundle = useUiStore((s) => s.bundle);
  const set = useUiStore((s) => s.set);
  if (!bundle) return null;
  const d = fileCardData(bundle, path);
  const basename = path.split("/").pop();
  const openFile = (p: string) => set({ drawerStack: push(useUiStore.getState().drawerStack, { kind: "record", type: "file", id: p }) });
  return (<>
    <div className="dc-header"><div className="dc-id-block">
      <div className="dc-id-row">
        <span className="dc-id file">{basename}</span>
        {d.layer && <span className={`dc-layer-chip layer-${d.layer}`}>{d.layer}</span>}
      </div>
      <div className="dc-summary dc-file-path">{path}</div>
      {d.frameName && <div className="dc-provenance">frame <span
        className="dc-frame-link" onClick={() => { set({ drawerStack: [] }); engineRef?.focusFrame(d.frameId); }}>
        {d.frameName}</span></div>}
    </div></div>
    <div className="dc-body">
      <Section label="importance"><div className="dc-prose">
        {d.fanIn} inbound · {d.fanOut} outbound
        {d.coChange.length > 0 && <> · co-changes with {d.coChange.slice(0, 4).map((c, i) => (
          <span key={c.path}>{i > 0 && ", "}<span className="dc-file-link"
            onClick={() => openFile(c.path)}>{c.path.split("/").pop()}</span></span>))}</>}
      </div></Section>
      {d.symbols.length > 0 && <Section label={`symbols (${d.symbols.length})`}>
        <div className="dc-ref-row">{d.symbols.map((s: any) => (
          <span key={s.id} className={`dc-ref-pill dc-symbol${symbol === s.name ? " highlighted" : ""}`}>
            <span className="type">{s.kind === "function" ? "fn" : s.kind}</span>
            <span className="name">{s.name}</span></span>))}</div></Section>}
      {d.connectionsIn.length > 0 && <Section label="called / imported by">
        <ConnList items={d.connectionsIn} onOpen={openFile} /></Section>}
      {d.connectionsOut.length > 0 && <Section label="calls / imports">
        <ConnList items={d.connectionsOut} onOpen={openFile} /></Section>}
      {d.decisions.length > 0 && <Section label="decisions">
        <div className="dc-ref-row">{d.decisions.map((dec: any) => (
          <RefPill key={dec.id} refObj={{ kind: "decision", id: dec.id }} />))}</div></Section>}
      {d.todos.length > 0 && <Section label="todos">
        <div className="dc-ref-row">{d.todos.map((t: any) => (
          <RefPill key={t.id} refObj={{ kind: "todo", id: t.id, name: `${todoDisplayId(t)} · ${t.summary}` }} />))}</div></Section>}
    </div>
  </>);
}
function ConnList({ items, onOpen }: { items: { path: string; count: number }[]; onOpen: (p: string) => void }) {
  return <div className="dc-conn-list">{items.map((c) => (
    <div key={c.path} className="dc-conn-row" onClick={() => onOpen(c.path)}>
      <span className="dc-conn-name">{c.path.split("/").pop()}</span>
      <span className="dc-conn-path">{c.path}</span>
      <span className="dc-conn-count">{c.count}</span></div>))}</div>;
}
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="dc-section"><div className="dc-section-label">{label}</div>{children}</div>;
}
