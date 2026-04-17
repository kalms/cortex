import { describe, it, expect } from 'vitest';
import { encodeServer, decodeClient } from '../../src/ws/protocol.js';
import type { ServerMsg, ClientMsg } from '../../src/ws/types.js';

describe('WS protocol', () => {
  it('encodes every ServerMsg variant as JSON', () => {
    const msgs: ServerMsg[] = [
      { type: 'hello', project_id: 'p', server_version: '0.2.0' },
      { type: 'pong' },
      { type: 'error', code: 'bad', message: 'm' },
    ];
    for (const m of msgs) {
      const s = encodeServer(m);
      expect(JSON.parse(s)).toEqual(m);
    }
  });

  it('decodes valid ClientMsg', () => {
    expect(decodeClient('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(decodeClient('{"type":"backfill","limit":10}')).toEqual({
      type: 'backfill',
      limit: 10,
    });
  });

  it('rejects unknown client types', () => {
    expect(() => decodeClient('{"type":"subscribe"}')).toThrow(/unknown/);
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeClient('{')).toThrow();
  });

  it('rejects non-object JSON', () => {
    expect(() => decodeClient('42')).toThrow();
    expect(() => decodeClient('"hello"')).toThrow();
  });
});
