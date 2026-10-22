import { describe, expect, it } from "vitest";
import { createWriteStream, mkdtempSync, statSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPostgres, scanDumpFile, type PgRunner } from "./backup-postgres.js";

const ROW = "1\t" + "x".repeat(1000) + "\n";
const ROWS = 650_000; // ~650 MB

async function writeBigDump(path: string): Promise<void> {
  const out = createWriteStream(path);
  const w = async (s: string) => { if (!out.write(s)) await once(out, "drain"); };
  await w("COPY public.pai_chunks (a, b) FROM stdin;\n");
  for (let i = 0; i < ROWS; i++) await w(ROW);
  await w("\\.\n-- PostgreSQL database dump complete\n");
  out.end();
  await once(out, "finish");
}

describe("streamed dump verification", () => {
  it("counts a >600 MB dump with bounded heap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-big-"));
    const file = join(dir, "big.sql");
    try {
      await writeBigDump(file);
      expect(statSync(file).size).toBeGreaterThan(600 * 1024 * 1024);
      global.gc?.();
      const base = process.memoryUsage().heapUsed;
      let peak = 0;
      const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
      const r = await scanDumpFile(file);
      clearInterval(t);
      expect(r.invalid).toBeNull();
      expect(r.counts.get("pai_chunks")).toBe(ROWS);
      expect(peak - base).toBeLessThan(150 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("backupPostgres verifies a large dump file and removes a truncated one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-big2-"));
    const file = join(dir, "x.sql");
    const runner: PgRunner = { async dump(_t, d) { await writeBigDump(d); return { pai_chunks: ROWS }; } };
    try {
      const r = await backupPostgres({ database: "d", user: "u" }, file, runner);
      expect(r.counts).toEqual({ pai_chunks: ROWS });
      const bad: PgRunner = { async dump(_t, d) { const o = createWriteStream(d); o.end("COPY pai_chunks (a) FROM stdin;\n1\n"); await once(o, "finish"); return { pai_chunks: 1 }; } };
      await expect(backupPostgres({ database: "d", user: "u" }, file, bad)).rejects.toThrow(/truncated/);
      expect(() => statSync(file)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
