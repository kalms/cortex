import type { ReactNode } from "react";
import { RefPill } from "./RefPill";
import { decisionDisplayId, todoDisplayId, formatRelativeDate } from "../display";
import { entityStore } from "../CanvasHost";
import { useUiStore } from "../ui-store";

export function DecisionView({ id }: { id: string }) {
  const removed = useUiStore((s) => s.removedSnapshots);
  const dec = entityStore.state.decisions[id] || removed[id];
  if (!dec) return null;
  const isRemoved = !entityStore.state.decisions[id];
  const childTodoIds: string[] = useUiStore.getState().bundle?.spawnsFrom?.[dec.id] || [];
  return (<>
    <div className="dc-header">
      <div className="dc-id-block">
        <div className="dc-id-row">
          <span className="dc-id">{decisionDisplayId(dec)}</span>
          <span className={`dc-state-pill ${dec.state}`}><span className="sw" />{dec.state}</span>
        </div>
        <div className="dc-summary">{dec.summary}</div>
        {(dec.id || dec.proposedBy || dec.proposedAt) && (
          <div className="dc-provenance">
            {[dec.id && `id ${dec.id}`, dec.proposedBy && <>proposed by <span className="agent">@{dec.proposedBy}</span></>,
              dec.proposedAt && formatRelativeDate(dec.proposedAt)].filter(Boolean)
              .map((part, i) => <span key={i}>{i > 0 && " · "}{part}</span>)}
          </div>)}
        {isRemoved && <div className="dc-removed-note">this decision was removed · view is a snapshot</div>}
      </div>
      {/* close button lives in Drawer chrome */}
    </div>
    <div className="dc-body">
      {dec.problem && <Section label="problem"><div className="dc-prose">{dec.problem}</div></Section>}
      {dec.resolution && <Section label="resolution"><div className="dc-prose">{dec.resolution}</div></Section>}
      {dec.rationale && <Section label="rationale"><div className="dc-prose">{dec.rationale}</div></Section>}
      {dec.alternatives?.length > 0 && <Section label="alternatives considered">
        <div className="dc-alt-list">{dec.alternatives.map((alt: any, i: number) => (
          <div className="dc-alt" key={i}><div className="dc-alt-title">{alt.title}</div>
            <div className="dc-alt-reason">{alt.reason}</div></div>))}</div></Section>}
      {dec.governs?.length > 0 && <Section label="governs">
        <div className="dc-ref-row">{dec.governs.map((g: any, i: number) => <RefPill key={i} refObj={g} />)}</div></Section>}
      {(dec.supersedes || dec.supersededBy) && <Section label="supersession">
        <div className="dc-supersedes-row">
          {dec.supersedes && <><span className="dc-supersedes-arrow">supersedes</span>
            <RefPill refObj={{ kind: "decision", id: dec.supersedes }} /></>}
          {dec.supersededBy && <><span className="dc-supersedes-arrow">superseded by</span>
            <RefPill refObj={{ kind: "decision", id: dec.supersededBy }} /></>}
        </div></Section>}
      {dec.relatedTo?.length > 0 && <Section label="related">
        <div className="dc-ref-row">{dec.relatedTo.map((rid: string) =>
          <RefPill key={rid} refObj={{ kind: "decision", id: rid }} />)}</div></Section>}
      {childTodoIds.length > 0 && <Section label="tasks">
        <div className="dc-ref-row">{childTodoIds.map((tid) => {
          const t = entityStore.state.todos[tid];
          return <RefPill key={tid} refObj={{ kind: "todo", id: tid,
            name: t ? `${todoDisplayId(t)} · ${t.summary}` : tid }} />; })}</div></Section>}
    </div>
  </>);
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return <div className="dc-section"><div className="dc-section-label">{label}</div>{children}</div>;
}
