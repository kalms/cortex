import { useEffect, useRef, useState } from "react";
import { LAYER_RGB } from "../../canvas/engine.js";
import { useUiStore } from "../ui-store";

const LEGEND_LAYERS = ["interface", "orchestration", "domain", "data", "infrastructure", "ceremony"] as const;

function swatchStyle(layer: string) {
  const rgb = (LAYER_RGB as Record<string, number[]>)[layer];
  return rgb ? { background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` } : undefined;
}

/** A single labeled on/off switch row (frames/decisions/todos/layer-tint). */
function LmToggle({ id, label, on, onToggle }: { id: string; label: string; on: boolean; onToggle: () => void }) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <div id={id} className={`lm-toggle${on ? " on" : ""}`} role="switch" aria-checked={on}
      tabIndex={0} onClick={onToggle} onKeyDown={onKeyDown}>
      <span className="sw" />{label}
    </div>
  );
}

export function LayersMenu() {
  const layerPrefs = useUiStore((s) => s.layerPrefs);
  const set = useUiStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const patch = (p: Partial<typeof layerPrefs>) => set({ layerPrefs: { ...layerPrefs, ...p } });

  return (
    <div className="layers-wrap" ref={wrapRef}>
      <button id="layers-toggle" title="Layers"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        layers
      </button>
      {!open ? null : (
        <div className="layers-menu" id="layers-menu">
          <LmToggle id="show-frames" label="frames" on={layerPrefs.showFrames}
            onToggle={() => patch({ showFrames: !layerPrefs.showFrames })} />
          <LmToggle id="show-decisions" label="decisions" on={layerPrefs.showDecisions}
            onToggle={() => patch({ showDecisions: !layerPrefs.showDecisions })} />
          <LmToggle id="show-todos" label="todos" on={layerPrefs.showTodos}
            onToggle={() => patch({ showTodos: !layerPrefs.showTodos })} />
          <div className="lm-sep" />
          <LmToggle id="layers-switch" label="layer tint" on={layerPrefs.layerTint}
            onToggle={() => patch({ layerTint: !layerPrefs.layerTint })} />
          <div className="lm-legend">
            {LEGEND_LAYERS.map((layer) => (
              <div className="lm-row" key={layer}>
                <i data-layer={layer} style={swatchStyle(layer)} />{layer}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
