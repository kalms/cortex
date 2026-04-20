export function parseBody(raw: string): Record<string, unknown> {
  return JSON.parse(raw);
}

export function handleRequest(body: string): Record<string, unknown> {
  const parsed = parseBody(body);
  return { ok: true, data: parsed };
}
