// src/viewer/app/api.ts
/** Network helpers used by the React shell on load + on project switch.
 *  Ported verbatim from the vanilla viewer's data-fetch.js. */

export type ProjectInfo = { name: string; indexed_at: string; root_path: string };

export async function fetchProjects(): Promise<{ projects: ProjectInfo[]; active: string | null }> {
  const r = await fetch("/api/projects");
  if (!r.ok) return { projects: [], active: null };
  return r.json();
}

export async function fetchGraph(project: string | null) {
  const url = project
    ? `/api/graph?project=${encodeURIComponent(project)}`
    : "/api/graph";
  const r = await fetch(url);
  if (!r.ok) return { nodes: [], edges: [], project: null };
  return r.json();
}

export async function fetchDecisions(project: string | null) {
  const url = project
    ? `/api/decisions?project=${encodeURIComponent(project)}`
    : "/api/decisions";
  const r = await fetch(url);
  if (!r.ok) return { decisions: [] };
  return r.json();
}

export async function fetchAggregates(project: string | null) {
  const url = project
    ? `/api/aggregates?project=${encodeURIComponent(project)}`
    : "/api/aggregates";
  const r = await fetch(url);
  if (!r.ok) return { aggregates: [] };
  return r.json();
}

export async function fetchFileEdges(project: string | null) {
  const url = project
    ? `/api/file-edges?project=${encodeURIComponent(project)}`
    : "/api/file-edges";
  const r = await fetch(url);
  if (!r.ok) return { file_edges: [] };
  return r.json();
}

export async function fetchFrames(project: string | null) {
  const url = project
    ? `/api/frames?project=${encodeURIComponent(project)}`
    : "/api/frames";
  const r = await fetch(url);
  if (!r.ok) return { frames: [], stage: { w: 1000, h: 800 } };
  return r.json();
}

export async function fetchTodos(project: string | null) {
  const url = project
    ? `/api/todos?project=${encodeURIComponent(project)}`
    : "/api/todos";
  const r = await fetch(url);
  if (!r.ok) return { todos: [] };
  return r.json();
}
