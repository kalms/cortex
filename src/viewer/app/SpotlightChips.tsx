import { engineRef } from "./CanvasHost";
import { useUiStore } from "./ui-store";
import { push } from "./drawer/drawer-stack";

/** Shared by SpotlightCard + StoryCard. Chip click must NEVER clear the
 *  spotlight (T-bty4): decisions/todos push drawer views on top, frames move
 *  the camera focus; both compose with the held spotlight. */
export function SpotlightChips({ resolved }: { resolved: { frames: string[]; decisions: string[]; todos: string[] } }) {
  const bundle = useUiStore((s) => s.bundle);
  if (resolved.frames.length === 0 && resolved.decisions.length === 0 && resolved.todos.length === 0) return null;
  const frameName = (id: string) => bundle?.frames?.find((f: any) => String(f.id) === String(id))?.name ?? `frame ${id}`;
  const open = (type: "decision" | "todo", id: string) => {
    const { drawerStack, set } = useUiStore.getState();
    set({ drawerStack: push(drawerStack, { kind: "record", type, id }) });
  };
  return (
    <div className="spotlight-chips">
      {resolved.frames.map((id) => (
        <span key={`f${id}`} className="dc-ref-pill" data-ref-kind="frame" onClick={() => engineRef?.focusFrame(id)}>
          <span className="type">frame</span><span className="name">{frameName(id)}</span>
        </span>
      ))}
      {resolved.decisions.map((id) => (
        <span key={`d${id}`} className="dc-ref-pill" data-ref-kind="decision" onClick={() => open("decision", id)}>
          <span className="type">decision</span><span className="name">{id}</span>
        </span>
      ))}
      {resolved.todos.map((id) => (
        <span key={`t${id}`} className="dc-ref-pill" data-ref-kind="todo" onClick={() => open("todo", id)}>
          <span className="type">todo</span><span className="name">{id}</span>
        </span>
      ))}
    </div>
  );
}
