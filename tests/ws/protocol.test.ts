import { describe, it, expect } from 'vitest';
import { encodeServer, decodeClient } from '../../src/ws/protocol.js';
import type { ServerMsg, ClientMsg } from '../../src/ws/types.js';

describe('WS protocol', () => {
  it('encodes every ServerMsg variant as JSON', () => {
    const msgs: ServerMsg[] = [
      { type: 'hello', project_id: 'p', server_version: '0.2.0', head_ulid: null },
      {
        type: 'projection',
        delta: { ulid: '01J00000000000000000000000', entity: 'decision', op: 'upsert', data: { id: 'd1' } },
      },
      {
        type: 'projection',
        delta: { ulid: '01J00000000000000000000001', entity: 'todo', op: 'remove', data: { id: 't1' } },
      },
      { type: 'catchup_result', mode: 'replay', deltas: [], head_ulid: '01J00000000000000000000001' },
      { type: 'catchup_result', mode: 'snapshot', deltas: [], head_ulid: null },
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
    expect(decodeClient('{"type":"catchup","since":"01J00000000000000000000000"}')).toEqual({
      type: 'catchup',
      since: '01J00000000000000000000000',
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

  describe('catchup payload validation', () => {
    it('rejects missing since', () => {
      expect(() => decodeClient('{"type":"catchup"}')).toThrow(/since/);
    });

    it('rejects since as number', () => {
      expect(() => decodeClient('{"type":"catchup","since":42}')).toThrow(/since/);
    });

    it('rejects since as object', () => {
      expect(() => decodeClient('{"type":"catchup","since":{}}')).toThrow(/since/);
    });

    it('rejects since as boolean', () => {
      expect(() => decodeClient('{"type":"catchup","since":true}')).toThrow(/since/);
    });

    it('rejects since as empty string', () => {
      expect(() => decodeClient('{"type":"catchup","since":""}')).toThrow(/since/);
    });

    it('accepts valid catchup', () => {
      expect(decodeClient('{"type":"catchup","since":"01J00000000000000000000000"}')).toEqual({
        type: 'catchup',
        since: '01J00000000000000000000000',
      });
    });
  });

  describe('backfill payload validation', () => {
    it('rejects limit as string', () => {
      expect(() => decodeClient('{"type":"backfill","limit":"x"}')).toThrow(/limit/);
    });

    it('rejects limit as Infinity', () => {
      expect(() => decodeClient('{"type":"backfill","limit":1e309}')).toThrow(/limit/);
    });

    it('rejects before_id as number', () => {
      expect(() => decodeClient('{"type":"backfill","before_id":99}')).toThrow(/before_id/);
    });

    it('accepts valid backfill with no optional fields', () => {
      expect(decodeClient('{"type":"backfill"}')).toEqual({ type: 'backfill' });
    });

    it('accepts valid backfill with limit and before_id', () => {
      expect(decodeClient('{"type":"backfill","before_id":"abc","limit":10}')).toEqual({
        type: 'backfill',
        before_id: 'abc',
        limit: 10,
      });
    });
  });
});
