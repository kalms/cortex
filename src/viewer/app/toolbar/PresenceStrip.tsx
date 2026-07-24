import { useState } from "react";
import { useUiStore } from "../ui-store";

// Session hues — keep in sync with PRESENCE_COLORS in canvas/presence.js (same
// 6 triples; the first three mirror the prototype's --agent-a/b/c slots).
const COLORS = ["#f59e0b", "#60a5fa", "#c084fc", "#34d399", "#fb7185", "#2dd4bf"];

/** Claude "session" provider glyph — the prototype's 4-line asterisk (v5). */
function ClaudeGlyph() {
  return (
    <svg viewBox="-8 -8 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <line className="glyph-line" x1="-5" y1="0" x2="5" y2="0" />
      <line className="glyph-line" x1="0" y1="-5" x2="0" y2="5" />
      <line className="glyph-line" x1="-3.5" y1="-3.5" x2="3.5" y2="3.5" />
      <line className="glyph-line" x1="-3.5" y1="3.5" x2="3.5" y2="-3.5" />
    </svg>
  );
}

/**
 * Overlapping session avatars (prototype v5 `.presence` strip): one 28px ring
 * per active session, session-colored, lifting on hover to reveal a
 * `presence-tip` showing @handle (workspace) + provider line (claude session +
 * short id). Idle sessions dim to a neutral grey. React owns this DOM — the
 * canvas presence layer draws cursors/heat, never the strip.
 */
export function PresenceStrip() {
  const showPresence = useUiStore((s) => s.layerPrefs.showPresence);
  const roster = useUiStore((s) => s.presenceRoster);
  const [hovered, setHovered] = useState<string | null>(null);

  if (!showPresence || roster.length === 0) return null;

  const tip = roster.find((r) => r.sessionId === hovered) ?? null;

  return (
    <div className="presence" aria-label="active sessions">
      {roster.map((r) => (
        <div
          key={r.sessionId}
          className={`avatar${r.idle ? " idle" : ""}${hovered === r.sessionId ? " lifted" : ""}`}
          style={r.idle ? undefined : { background: COLORS[r.colorIdx] }}
          onMouseEnter={() => setHovered(r.sessionId)}
          onMouseLeave={() => setHovered((h) => (h === r.sessionId ? null : h))}
        >
          <ClaudeGlyph />
        </div>
      ))}
      <div className={`presence-tip${tip ? " visible" : ""}`}>
        <span className="handle">@{tip?.workspace ?? ""}</span>
        <span className="provider">
          claude session · {tip ? tip.sessionId.slice(0, 6) : ""}
        </span>
      </div>
    </div>
  );
}
