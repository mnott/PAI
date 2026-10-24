import { describe, it, expect, vi } from 'vitest';
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

describe('restartRouter successor diag', () => {
  it('the abort line carries the successor diag, then the restarter lookup, in that order', async () => {
    const { abortedText } = await import('./supervisor.js');
    const { diagnoseSuccessor, restarterLookup } = await import('./preflight.js');
    const diag = await diagnoseSuccessor('api.anthropic.com', {
      lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
      resolve4: async () => ['1.2.3.4'],
      servers: () => ['100.100.100.100'],
      dscacheutil: async () => '160.79.104.10',
    });
    expect(diag).toMatch(/^successor lookup=ENOTFOUND \d+ms resolve4=ok \d+ms servers=100\.100\.100\.100 dscacheutil=160\.79\.104\.10$/);
    const st = { oldPid: 37661, state: 'failed' as const, reason: 'successor cannot reach api.anthropic.com: ETIMEDOUT', diag };
    const r = await restarterLookup('api.anthropic.com', async () => undefined);
    const text = abortedText(st, r)!;
    expect(text.startsWith('router restart aborted: successor cannot reach api.anthropic.com: ETIMEDOUT; old router 37661 keeps serving; diag successor lookup=ENOTFOUND')).toBe(true);
    expect(text.indexOf('resolve4=')).toBeLessThan(text.indexOf('servers='));
    expect(text.indexOf('servers=')).toBeLessThan(text.indexOf('dscacheutil='));
    expect(text.endsWith('; restarter lookup=ok')).toBe(true);
    expect(await restarterLookup('h', async () => { throw { code: 'ENOTFOUND' }; })).toBe('restarter lookup=ENOTFOUND');
  });

  it('a passing preflight runs no diag', async () => {
    const probes = { lookup: vi.fn(), resolve4: vi.fn(), servers: vi.fn(), dscacheutil: vi.fn() };
    const r = await restartRouter({ oldPid: 7, spawnNew: () => 8, isUp: async () => true, preflight: async () => ({ ok: true, host: 'h' }) });
    expect(r.newPid).toBe(8);
    expect(probes.lookup).not.toHaveBeenCalled();
  });
});
