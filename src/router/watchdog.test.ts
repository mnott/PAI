import { describe, it, expect } from 'vitest';
import { createRouterWatchdog } from './supervisor.js';
import { createUpstreamStreak, type UpstreamHealth } from './preflight.js';

const base = (o: Partial<Parameters<typeof createRouterWatchdog>[0]> = {}) => {
  const logs: string[] = [];
  let restarts = 0;
  const d = {
    pid: () => 1,
    health: () => ({ streak: 5, code: 'ENOTFOUND' }),
    failStreak: 5,
    ownProbe: async () => ({ ok: true, host: 'api.anthropic.com' }),
    restart: async () => { restarts++; },
    log: (l: string) => logs.push(l),
    ...o,
  };
  return { check: createRouterWatchdog(d), logs, restarts: () => restarts };
};

describe('router watchdog', () => {
  it('restarts when the streak reaches failStreak and the daemon reaches the upstream', async () => {
    const w = base();
    expect(await w.check()).toBe('restarted');
    expect(w.restarts()).toBe(1);
    expect(w.logs).toEqual(['router watchdog: successor cannot reach upstream, restarted']);
  });
  it('does nothing below the streak', async () => {
    const w = base({ health: () => ({ streak: 4 }) });
    expect(await w.check()).toBe('ok');
    expect(w.restarts()).toBe(0);
  });
  it('only logs when the daemon cannot reach the upstream either (no restart loop)', async () => {
    const w = base({ ownProbe: async () => ({ ok: false, host: 'api.anthropic.com', code: 'ENOTFOUND' }) });
    expect(await w.check()).toBe('network-down');
    expect(w.restarts()).toBe(0);
    expect(w.logs[0]).toMatch(/network down, not restarting/);
  });
  it('waits out the cooldown between attempts', async () => {
    let t = 0;
    const w = base({ now: () => t });
    expect(await w.check()).toBe('restarted');
    t = 1000;
    expect(await w.check()).toBe('cooldown');
    expect(w.restarts()).toBe(1);
  });
  it('reports a failed restart', async () => {
    const w = base({ restart: async () => { throw new Error('router restart aborted: x'); } });
    expect(await w.check()).toBe('failed');
  });
});

describe('upstream streak', () => {
  it('counts network failures within the window, resets on success, ignores other codes', () => {
    let t = 0;
    const seen: Array<UpstreamHealth | undefined> = [];
    const s = createUpstreamStreak({ pid: 9, now: () => t, write: (h) => seen.push(h) });
    s.failure('ENOTFOUND'); s.failure('EPIPE'); s.failure('ETIMEDOUT');
    expect(seen.at(-1)?.streak).toBe(2);
    s.success();
    expect(seen.at(-1)).toBeUndefined();
    s.failure('ECONNREFUSED'); t = 61_000; s.failure('ECONNREFUSED');
    expect(seen.at(-1)?.streak).toBe(1);
  });
});
