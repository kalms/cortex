import { useUiStore } from "../ui-store";
import { push } from "./drawer-stack";
import { engineRef, entityStore } from "../CanvasHost";
import { decisionDisplayId, todoDisplayId } from "../display";

export function RefPill({ refObj }: { refObj: any }) {
  const label = (() => {
    switch (refObj.kind) {
      case "frame": return { type: "frame", name: refObj.label || refObj.id };
      case "file": return { type: "file", name: refObj.path.split("/").pop() };
      case "function": return { type: "fn", name: refObj.name + "()" };
      case "symbol": return { type: "symbol", name: refObj.name };
      case "decision": return { type: "decision", name: decisionDisplayId(entityStore.state.decisions[refObj.id] || refObj) };
      case "todo": return { type: "todo", name: refObj.name || todoDisplayId(entityStore.state.todos[refObj.id] || refObj) };
      case "pr": return { type: "pr", name: refObj.id ? `#${refObj.id}` : refObj.name || "" };
      default: return { type: refObj.kind || "", name: refObj.name || refObj.id || refObj.path || "" };
    }
  })();
  const onClick = () => {
    const { drawerStack, set } = useUiStore.getState();
    if (refObj.kind === "decision" && entityStore.state.decisions[refObj.id])
      return set({ drawerStack: push(drawerStack, { kind: "record", type: "decision", id: refObj.id }) });
    if (refObj.kind === "todo" && entityStore.state.todos[refObj.id])
      return set({ drawerStack: push(drawerStack, { kind: "record", type: "todo", id: refObj.id }) });
    if (refObj.kind === "file" && refObj.path)
      return set({ drawerStack: push(drawerStack, { kind: "record", type: "file", id: refObj.path }) });
    const frameId = refObj.kind === "frame" ? refObj.id
      : refObj.path ? engineRef?.frameIdForFilePath(refObj.path) : null;
    if (frameId) { set({ drawerStack: [] }); engineRef?.focusFrame(frameId); }
  };
  return (
    <span className="dc-ref-pill" data-ref-kind={refObj.kind} onClick={onClick}>
      <span className="type">{label.type}</span><span className="name">{label.name}</span>
    </span>
  );
}
