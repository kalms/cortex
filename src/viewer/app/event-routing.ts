// src/viewer/app/event-routing.ts
/**
 * Does a live or backfilled event belong to the project currently on screen?
 *
 * ws-client filters `projection` deltas by the bound project but never `event`
 * messages, so this guard is the viewer's own. It used to be unnecessary: the
 * server's single-home-repo gate meant only one repo's beacons could exist at
 * all. Now that acceptance is registry membership, a beacon for a repo you are
 * not looking at can reach this tab, and applying it would paint another repo's
 * refs onto this canvas's frame index.
 *
 * Permissive in two cases, both deliberate:
 *   - `project_id` empty — events persisted before the field was stamped are
 *     still inside the 24 h retention window; dropping them would blank replay
 *     on upgrade for no safety gain.
 *   - `currentProject` null — pre-boot, before fetchProjects() resolves. The
 *     caller buffers these until the frame index lands rather than dropping them.
 */
export function belongsToProject(
  event: { project_id?: string },
  currentProject: string | null,
): boolean {
  if (!currentProject) return true;
  if (!event.project_id) return true;
  return event.project_id === currentProject;
}
