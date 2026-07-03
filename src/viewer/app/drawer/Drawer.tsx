import { useEffect, useReducer } from "react";
import { useUiStore } from "../ui-store";
import { pop, closeAll } from "./drawer-stack";
import { entityStore } from "../CanvasHost";
import { DecisionView } from "./DecisionView";
import { TodoView } from "./TodoView";
import { FileCard } from "./FileCard";     // Task 7 — stub until then
import { ListView } from "./ListView";     // Task 8 — stub until then

export function Drawer() {
  const stack = useUiStore((s) => s.drawerStack);
  const set = useUiStore((s) => s.set);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => entityStore.subscribe(() => bump()), []);
  const top = stack[stack.length - 1];
  return (
    <div className={`decision-card${top ? " visible" : ""}`} id="decision-card">
      {top && (<>
        <div className="dc-nav">
          {stack.length > 1 && <button className="dc-back" aria-label="back"
            onClick={() => set({ drawerStack: pop(stack) })}>‹</button>}
          <button className="dc-close" aria-label="close"
            onClick={() => set({ drawerStack: closeAll() })}>×</button>
        </div>
        {top.kind === "record" && top.type === "decision" && <DecisionView id={top.id} />}
        {top.kind === "record" && top.type === "todo" && <TodoView id={top.id} />}
        {top.kind === "record" && top.type === "file" && <FileCard path={top.id} symbol={top.symbol} />}
        {top.kind === "list" && <ListView tab={top.tab} />}
      </>)}
    </div>
  );
}
