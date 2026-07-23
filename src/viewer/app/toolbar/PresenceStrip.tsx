import { useUiStore } from "../ui-store";

// Keep in sync with PRESENCE_COLORS in canvas/presence.js (same 6 triples).
const COLORS = ["#f59e0b", "#60a5fa", "#c084fc", "#34d399", "#fb7185", "#2dd4bf"];

/** One dot per active session; workspace label in the title tooltip; idle = dimmed. */
export function PresenceStrip() {
  const showPresence = useUiStore((s) => s.layerPrefs.showPresence);
  const roster = useUiStore((s) => s.presenceRoster);

  if (!showPresence || roster.length === 0) return null;

  return (
    <div className="presence-strip" aria-label="active sessions">
      {roster.map((r) => (
        <span key={r.sessionId} title={`${r.workspace}${r.idle ? " (idle)" : ""}`}
          className={`presence-avatar${r.idle ? " idle" : ""}`}
          style={{ background: COLORS[r.colorIdx] }}>
          {r.workspace.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </div>
  );
}
