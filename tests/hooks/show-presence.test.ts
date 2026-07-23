import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(__dirname, '../../hooks/show-presence.sh');
let server: Server; let base: string; let bodies: any[] = [];
let repo: string;

const runHook = (payload: object, env: Record<string, string> = {}) => {
  execFileSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CORTEX_PRESENCE_URL: base, ...env },
  });
};
// The POST is backgrounded; poll briefly for arrival.
const waitFor = async (n: number) => {
  for (let i = 0; i < 40 && bodies.length < n; i++) await new Promise((r) => setTimeout(r, 50));
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'presence-hook-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export {}\n');
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { bodies.push({ url: req.url, body: JSON.parse(raw) }); res.writeHead(200).end('{"version":1,"accepted":true}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); rmSync(repo, { recursive: true, force: true }); });

describe('show-presence hook', () => {
  it('Read → studied with repo-relative ref', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Read', tool_input: { file_path: join(repo, 'src', 'a.ts') }, cwd: repo });
    await waitFor(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toBe('/api/presence');
    expect(bodies[0].body).toMatchObject({ session_id: 'sess-1', activity: 'studied', refs: ['src/a.ts'] });
    expect(bodies[0].body.repo_path.length).toBeGreaterThan(0);
    expect(bodies[0].body.workspace).toBe(repo.split('/').pop());
  });

  it('Edit → edited', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'a.ts') }, cwd: repo });
    await waitFor(1);
    expect(bodies[0].body.activity).toBe('edited');
  });

  it('drops files outside the git root (scope filter)', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, cwd: repo });
    await new Promise((r) => setTimeout(r, 400));
    expect(bodies).toHaveLength(0);
  });

  it('MCP trace_path → traced with qualified name', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'mcp__plugin_cortex_cortex__trace_path',
      tool_input: { function_name: 'src/a.ts::fn', repo_path: repo }, cwd: repo });
    await waitFor(1);
    expect(bodies[0].body).toMatchObject({ activity: 'traced', refs: ['src/a.ts::fn'] });
  });

  it('decision why → consulted; decision create → dropped (no double-coverage)', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'mcp__plugin_cortex_cortex__decision',
      tool_input: { action: 'why', qualified_name: 'src/a.ts', repo_path: repo }, cwd: repo });
    await waitFor(1);
    expect(bodies[0].body.activity).toBe('consulted');
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'mcp__plugin_cortex_cortex__decision',
      tool_input: { action: 'create', title: 't', repo_path: repo }, cwd: repo });
    await new Promise((r) => setTimeout(r, 400));
    expect(bodies).toHaveLength(0);
  });

  it('CORTEX_PRESENCE=0 disables', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Read', tool_input: { file_path: join(repo, 'src', 'a.ts') }, cwd: repo }, { CORTEX_PRESENCE: '0' });
    await new Promise((r) => setTimeout(r, 400));
    expect(bodies).toHaveLength(0);
  });
});
