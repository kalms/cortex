import type { ReactNode } from "react";
import { RefPill } from "./RefPill";
import { todoDisplayId } from "../display";
import { entityStore } from "../CanvasHost";
import { useUiStore } from "../ui-store";
import { resolveTodo } from "./selectors";

export function TodoView({ id }: { id: string }) {
  const removed = useUiStore((s) => s.removedSnapshots);
  const bundle = useUiStore((s) => s.bundle);
  const { todo: t, isRemoved } = resolveTodo(entityStore.state.todos, bundle?.allTodos, removed, id);
  if (!t) return null;
  return (<>
    <div className="dc-header">
      <div className="dc-id-block">
        <div className="dc-id-row">
          <span className="dc-id todo">{todoDisplayId(t)}</span>
          <span className={`dc-state-pill ${t.state || ""}`}><span className="sw" />{t.state || ""}</span>
        </div>
        <div className="dc-summary">{t.summary || ""}</div>
        {(t.id || t.proposedBy || t.proposedAt) && (
          <div className="dc-provenance">
            {[t.id && `id ${t.id}`, t.proposedBy && <>proposed by <span className="agent">@{t.proposedBy}</span></>,
              t.proposedAt && `on ${t.proposedAt}`].filter(Boolean)
              .map((part, i) => <span key={i}>{i > 0 && " · "}{part}</span>)}
          </div>)}
        {isRemoved && <div className="dc-removed-note">this todo was removed · view is a snapshot</div>}
      </div>
      {/* close button lives in Drawer chrome */}
    </div>
    <div className="dc-body">
      {t.description && <Section label="description"><div className="dc-prose">{t.description}</div></Section>}
      {t.governs?.length > 0 && <Section label="governs">
        <div className="dc-ref-row">{t.governs.map((g: any, i: number) => <RefPill key={i} refObj={g} />)}</div></Section>}
      {t.spawnsFrom && <Section label="spawned from">
        <div className="dc-ref-row"><RefPill refObj={{ kind: "decision", id: t.spawnsFrom }} /></div></Section>}
      {t.resolvedBy?.length > 0 && <Section label="resolved by">
        <div className="dc-ref-row">{t.resolvedBy.map((prId: string) =>
          <RefPill key={prId} refObj={{ kind: "pr", id: prId }} />)}</div></Section>}
      {(t.blockedBy?.length > 0 || t.blocks?.length > 0) && <Section label="dependencies">
        <div className="dc-ref-row">
          {(t.blockedBy || []).map((r: any) => <RefPill key={`b-${r.id}`} refObj={{ kind: "todo", id: r.id }} />)}
          {(t.blocks || []).map((r: any) => <RefPill key={`k-${r.id}`} refObj={{ kind: "todo", id: r.id }} />)}
        </div></Section>}
      {t.relatedTo?.length > 0 && <Section label="related">
        <div className="dc-ref-row">{t.relatedTo.map((r: any) =>
          <RefPill key={r.id} refObj={{ kind: "todo", id: r.id }} />)}</div></Section>}
    </div>
  </>);
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return <div className="dc-section"><div className="dc-section-label">{label}</div>{children}</div>;
}
