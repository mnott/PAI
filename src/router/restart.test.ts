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
