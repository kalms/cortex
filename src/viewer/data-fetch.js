// src/viewer/data-fetch.js
/** Network helpers used by viewer.js on load + on project switch. */

export async function fetchProjects() {
  const r = await fetch("/api/projects");
  if (!r.ok) return { projects: [], active: null };
  return r.json();
}

export async function fetchGraph(project) {
  const url = project
    ? `/api/graph?project=${encodeURIComponent(project)}`
    : "/api/graph";
  const r = await fetch(url);
  if (!r.ok) return { nodes: [], edges: [], project: null };
  return r.json();
}

export async function fetchDecisions(project) {
  const url = project
    ? `/api/decisions?project=${encodeURIComponent(project)}`
    : "/api/decisions";
  const r = await fetch(url);
  if (!r.ok) return { decisions: [] };
  return r.json();
}

export async function fetchAggregates(project) {
  const url = project
    ? `/api/aggregates?project=${encodeURIComponent(project)}`
    : "/api/aggregates";
  const r = await fetch(url);
  if (!r.ok) return { aggregates: [] };
  return r.json();
}

export async function fetchFileEdges(project) {
  const url = project
    ? `/api/file-edges?project=${encodeURIComponent(project)}`
    : "/api/file-edges";
  const r = await fetch(url);
  if (!r.ok) return { file_edges: [] };
  return r.json();
}
