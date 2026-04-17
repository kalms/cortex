import { describe, it, expect, vi } from 'vitest';
import { ClientRegistry } from '../../src/ws/client-registry.js';

function fakeClient() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 /* OPEN */ } as any;
}

describe('ClientRegistry', () => {
  it('tracks added clients', () => {
    const r = new ClientRegistry();
    const c = fakeClient();
    r.add(c);
    expect(r.size()).toBe(1);
  });

  it('broadcasts a string to every open client', () => {
    const r = new ClientRegistry();
    const a = fakeClient(); const b = fakeClient();
    r.add(a); r.add(b);
    r.broadcast('hello');
    expect(a.send).toHaveBeenCalledWith('hello');
    expect(b.send).toHaveBeenCalledWith('hello');
  });

  it('skips and evicts a client whose send() throws', () => {
    const r = new ClientRegistry();
    const good = fakeClient();
    const bad = fakeClient();
    bad.send.mockImplementation(() => { throw new Error('send fail'); });
    r.add(good); r.add(bad);
    r.broadcast('x');
    expect(good.send).toHaveBeenCalled();
    expect(bad.close).toHaveBeenCalled();
    expect(r.size()).toBe(1);
  });

  it('remove() drops a client', () => {
    const r = new ClientRegistry();
    const c = fakeClient();
    r.add(c);
    r.remove(c);
    expect(r.size()).toBe(0);
  });
});
