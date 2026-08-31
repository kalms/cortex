// src/events/show-events.ts
// Pure envelope builders for the three show-your-work event kinds. Extracted
// from src/index.ts so the identity a beacon carries is unit-testable without
// booting a server: `project_id` is the RESOLVED registry name (not the server's
// bound project) and the payload names the RESOLVED checkout (not the posted
// path), which together are what let a host serving many repos route an event
// to the one canvas whose graph the refs were resolved against.
import type { Event } from "./types.js";
import type { BeaconTarget } from "../mcp-server/beacon-target.js";
import type { PresencePost, ShowFocusPost, ShowAdvancePost } from "../mcp-server/api-schemas.js";

export function presenceActivityEvent(
  p: PresencePost, t: BeaconTarget, id: string, createdAt: number,
): Event {
  return {
    id,
    kind: "presence.activity",
    actor: "claude",
    created_at: createdAt,
    project_id: t.name,
    payload: {
      session_id: p.session_id,
      workspace: p.workspace,
      repo_path: t.root_path,
      activity: p.activity,
      refs: p.refs,
    },
  };
}

export function showFocusEvent(
  p: ShowFocusPost, t: BeaconTarget, id: string, createdAt: number,
): Event {
  return {
    id,
    kind: "show.focus",
    actor: "claude",
    created_at: createdAt,
    project_id: t.name,
    payload: { refs: p.refs, note: p.note, repo_path: t.root_path },
  };
}

export function showAdvanceEvent(
  p: ShowAdvancePost, t: BeaconTarget, id: string, createdAt: number,
): Event {
  return {
    id,
    kind: "show.advance",
    actor: "claude",
    created_at: createdAt,
    project_id: t.name,
    payload: { story_id: p.story_id, step: p.step, repo_path: t.root_path },
  };
}
