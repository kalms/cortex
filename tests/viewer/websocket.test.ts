import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWsClient, BACKOFF_MS, HEARTBEAT_MS } from '../../src/viewer/shared/websocket.js';

class MockWS {
  static instances: MockWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

beforeEach(() => {
  MockWS.instances = [];
  vi.useFakeTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('websocket client', () => {
  it('exposes BACKOFF_MS 1s/2s/4s/... capped at 30s', () => {
    expect(BACKOFF_MS[0]).toBe(1000);
    expect(BACKOFF_MS[1]).toBe(2000);
    expect(BACKOFF_MS[2]).toBe(4000);
    expect(BACKOFF_MS[BACKOFF_MS.length - 1]).toBe(30000);
  });

  it('HEARTBEAT_MS is 30 seconds', () => {
    expect(HEARTBEAT_MS).toBe(30000);
  });

  it('dispatches hello, event, mutation, backfill_page to callbacks', () => {
    const onHello = vi.fn();
    const onEvent = vi.fn();
    const onMutation = vi.fn();
    const onBackfill = vi.fn();
    createWsClient({ url: 'ws://x/ws', onHello, onEvent, onMutation, onBackfill });
    const ws = MockWS.instances[0]!;
    ws.open();
    ws.receive({ type: 'hello', project_id: 'p', server_version: '1' });
    ws.receive({ type: 'event', event: { id: 'e1' } });
    ws.receive({ type: 'mutation', mutation: { op: 'add_node', node: { id: 'n' } } });
    ws.receive({ type: 'backfill_page', events: [{ id: 'e0' }], mutations: [], has_more: false });
    expect(onHello).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({ id: 'e1' });
    expect(onMutation).toHaveBeenCalled();
    expect(onBackfill).toHaveBeenCalled();
  });

  it('dedupes events by id', () => {
    const onEvent = vi.fn();
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent, onMutation: () => {}, onBackfill: () => {} });
    const ws = MockWS.instances[0]!;
    ws.open();
    ws.receive({ type: 'event', event: { id: 'same' } });
    ws.receive({ type: 'event', event: { id: 'same' } });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('sends ping every HEARTBEAT_MS', () => {
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent: () => {}, onMutation: () => {}, onBackfill: () => {} });
    const ws = MockWS.instances[0]!;
    ws.open();
    expect(ws.sent.length).toBe(0);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(JSON.parse(ws.sent[0]!).type).toBe('ping');
  });

  it('reconnects with backoff after close', () => {
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent: () => {}, onMutation: () => {}, onBackfill: () => {} });
    const ws1 = MockWS.instances[0]!;
    ws1.open();
    ws1.close();
    expect(MockWS.instances.length).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(MockWS.instances.length).toBe(2);
  });

  it('sends backfill with before_id = last seen on reconnect', () => {
    createWsClient({ url: 'ws://x/ws', onHello: () => {}, onEvent: () => {}, onMutation: () => {}, onBackfill: () => {} });
    const ws1 = MockWS.instances[0]!;
    ws1.open();
    ws1.receive({ type: 'event', event: { id: 'latest-id' } });
    ws1.close();
    vi.advanceTimersByTime(1000);
    const ws2 = MockWS.instances[1]!;
    ws2.open();
    const backfillMsg = ws2.sent.map(s => JSON.parse(s)).find(m => m.type === 'backfill');
    expect(backfillMsg).toBeTruthy();
    expect(backfillMsg.before_id).toBe('latest-id');
  });
});
