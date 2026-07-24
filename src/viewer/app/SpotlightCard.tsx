import { engineRef } from "./CanvasHost";
import { useUiStore } from "./ui-store";

function countsLine(resolved: { frames: string[]; decisions: string[]; todos: string[] }): string {
  const parts: string[] = [];
  if (resolved.frames.length) parts.push(`${resolved.frames.length} frame${resolved.frames.length === 1 ? "" : "s"}`);
  if (resolved.decisions.length) parts.push(`${resolved.decisions.length} decision${resolved.decisions.length === 1 ? "" : "s"}`);
  if (resolved.todos.length) parts.push(`${resolved.todos.length} todo${resolved.todos.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function SpotlightCard() {
  const spotlight = useUiStore((s) => s.spotlight);
  if (!spotlight) return null;

  const counts = countsLine(spotlight.resolved);

  return (
    <div className="spotlight-card" id="spotlight-card">
      <div className="spotlight-card-body">
        <div className="spotlight-card-note">{spotlight.note || "Spotlight"}</div>
        {counts && <div className="spotlight-card-counts">{counts}</div>}
        {spotlight.unresolved.length > 0 &&
          <div className="spotlight-card-unresolved">not in graph: {spotlight.unresolved.join(", ")}</div>}
      </div>
      <kbd className="spotlight-card-esc">esc</kbd>
      <button className="spotlight-card-dismiss" aria-label="Dismiss"
        onClick={() => engineRef?.applySpotlight(null)}>×</button>
    </div>
  );
}
