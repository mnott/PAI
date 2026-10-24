import { describe, it, expect } from 'vitest';
import { routerRestartText } from './service-control.js';

describe('routerRestartText', () => {
  it('delegates to the daemon when it runs', async () => {
    const calls: string[] = [];
    const out = await routerRestartText('cli', { daemonUp: async () => true, call: async (m) => { calls.push(m); return 'router restarted (via daemon)'; } });
    expect(calls).toEqual(['router_restart']);
    expect(out).toBe('router restarted (via daemon)');
  });
  it('surfaces an abort from the daemon', async () => {
    await expect(routerRestartText('cli', { daemonUp: async () => true, call: async () => { throw new Error('router restart aborted: x'); } })).rejects.toThrow(/aborted/);
  });
});
