/**
 * POST a JSON body to the local viewer HTTP server (spec: show-focus
 * spotlight delivery, task 4). The MCP server and the viewer's HTTP server
 * are separate processes on the same machine — this is the bridge between
 * them: an MCP tool call posts here, the viewer's `/api/show-focus` handler
 * relays it to connected viewer clients over its own transport.
 *
 * Port discovery tries, in order: `env.CORTEX_VIEWER_PORT` (explicit
 * override), then the two conventional ports (`3333` plugin default, `3334`
 * dev-server default) — see CLAUDE.md's Viewer section. Empty candidates are
 * skipped and duplicates are deduped so a `CORTEX_VIEWER_PORT=3333` doesn't
 * try the same port twice.
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
  const candidates = [env.CORTEX_VIEWER_PORT, "3333", "3334"];
  const ports: string[] = [];
  for (const p of candidates) {
    if (!p) continue;
    if (ports.includes(p)) continue;
    ports.push(p);
  }

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
