import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

const MOD = resolve(__dirname, 'session-notes.ts');

describe('createSessionNote multi-process', () => {
  it('8 concurrent processes get 8 distinct numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notes-race-'));
    const script = join(dir, 'child.mts');
    writeFileSync(script, `import { createSessionNote } from ${JSON.stringify(MOD)};
const t = Number(process.argv[3]);
while (Date.now() < t) {}
createSessionNote(process.argv[2], 'race');`);
    const notes = join(dir, 'Notes');
    const start = Date.now() + 4000;
    const tsx = resolve(__dirname, '../../../../../node_modules/.bin/tsx');
    await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((res, rej) => {
      const c = spawn(tsx, [script, notes, String(start)], { stdio: 'ignore' });
      c.on('exit', code => (code === 0 ? res() : rej(new Error('child exit ' + code))));
    })));
    const now = new Date();
    const month = join(notes, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'));
    const files = readdirSync(month);
    expect(files.filter(f => f.endsWith('.claim'))).toEqual([]);
    expect(files.length).toBe(8);
    expect(new Set(files.map(f => f.slice(0, 4))).size).toBe(8);
    rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
