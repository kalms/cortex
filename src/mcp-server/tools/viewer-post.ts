/**
 * Candidate ports to try, in order: `env.CORTEX_VIEWER_PORT` (explicit
 * override) first, then the two conventional ports (`3333` plugin default,
 * `3334` dev-server default) — see CLAUDE.md's Viewer section. Empty
 * candidates are skipped and duplicates deduped so a `CORTEX_VIEWER_PORT=3333`
 * doesn't try the same port twice. Shared by {@link postToViewer} and
 * {@link discoverViewerPort} so both probe the exact same candidate set in
 * the exact same order.
 */
function candidatePorts(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.CORTEX_VIEWER_PORT, "3333", "3334"];
  const ports: string[] = [];
  for (const p of candidates) {
    if (!p) continue;
    if (ports.includes(p)) continue;
    ports.push(p);
  }
  return ports;
}

/**
 * POST a JSON body to the local viewer HTTP server (spec: show-focus
 * spotlight delivery, task 4). The MCP server and the viewer's HTTP server
 * are separate processes on the same machine — this is the bridge between
 * them: an MCP tool call posts here, the viewer's `/api/show-focus` handler
 * relays it to connected viewer clients over its own transport.
 *
 * Port discovery: see {@link candidatePorts}.
 *
 * Never throws: an unreachable/timed-out/erroring viewer is a normal,
 * expected condition (no viewer running), not a tool failure — callers get
 * `{ delivered: false, accepted: false }` and report that to the user.
 */
export async function postToViewer(
  path: string,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ delivered: boolean; accepted: boolean }> {
  const ports = candidatePorts(env);

  for (const port of ports) {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (env.CORTEX_API_TOKEN) headers["Authorization"] = `Bearer ${env.CORTEX_API_TOKEN}`;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) {
        let accepted = false;
        try {
          const json = (await res.json()) as { accepted?: unknown };
          accepted = json.accepted === true;
        } catch {
          accepted = false;
        }
        return { delivered: true, accepted };
      }
    } catch {
      // Unreachable, timed out, or non-JSON — try the next candidate port.
    }
  }
  return { delivered: false, accepted: false };
}

/**
 * First port whose `/api/health` answers 200 within 500 ms; null when none.
 * Same candidate order as {@link postToViewer} (via {@link candidatePorts}).
 * Used only to compose a `viewer_url` for a freshly-created story — a dead
 * viewer falls back to the conventional default port, never an error, so
 * this never throws either.
 */
export async function discoverViewerPort(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const ports = candidatePorts(env);

  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return port;
    } catch {
      // Unreachable, timed out, or erroring — try the next candidate port.
    }
  }
  return null;
}
