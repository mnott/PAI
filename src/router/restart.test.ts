import { describe, it, expect } from 'vitest';
import { restartRouter } from './restart.js';

describe('restartRouter', () => {
  it('readyMs includes the time spent spawning', async () => {
    let t = 0;
    const r = await restartRouter({
      oldPid: undefined,
      spawnNew: () => { t += 700; return 42; },
      isUp: async () => true,
      now: () => t,
    });
    expect(r.newPid).toBe(42);
    expect(r.readyMs).toBe(700);
  });
});

describe('restartRouter preflight', () => {
  it('aborts before starting anything when the upstream is unreachable, old router keeps serving', async () => {
    let spawned = 0, handed = 0;
    await expect(restartRouter({
      oldPid: 7,
      spawnNew: () => { spawned++; return 8; },
      handover: () => { handed++; return null; },
      isUp: async () => true,
      preflight: async () => ({ ok: false, host: 'api.anthropic.com', code: 'ENOTFOUND' }),
    })).rejects.toThrow('router restart aborted: successor cannot reach api.anthropic.com: ENOTFOUND; old router 7 keeps serving');
    expect(spawned + handed).toBe(0);
  });

  it('proceeds when the preflight succeeds', async () => {
    const r = await restartRouter({ oldPid: 7, spawnNew: () => 8, isUp: async () => true, preflight: async () => ({ ok: true, host: 'h' }) });
    expect(r.newPid).toBe(8);
  });

  it('aborts when the spawned successor reports it cannot reach the upstream (old router still answers)', async () => {
    await expect(restartRouter({
      oldPid: 7,
      spawnNew: () => 8,
      isUp: async () => true,
      aborted: () => 'router restart aborted: successor cannot reach h: ENOTFOUND; old router 7 keeps serving',
    })).rejects.toThrow(/aborted/);
  });

  it('keeps polling while the old router answers and the successor is not settled', async () => {
    let n = 0;
    const r = await restartRouter({ oldPid: 7, spawnNew: () => 8, isUp: async () => true, settled: () => ++n > 3, pollMs: 1 });
    expect(n).toBe(4);
    expect(r.newPid).toBe(8);
  });
});
