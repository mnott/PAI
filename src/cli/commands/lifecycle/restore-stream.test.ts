import { describe, expect, it } from "vitest";
import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restorePostgres, type PgRunner } from "./restore.js";

const ROW = "1\t" + "x".repeat(1000) + "\n";
const ROWS = 650_000; // ~650 MB
const T = { database: "pai", user: "pai" };

async function writeBigDump(path: string): Promise<void> {
  const out = createWriteStream(path);
  const w = async (s: string) => { if (!out.write(s)) await once(out, "drain"); };
  await w("COPY public.pai_chunks (a, b) FROM stdin;\n");
  for (let i = 0; i < ROWS; i++) await w(ROW);
  await w("\\.\n-- PostgreSQL database dump complete\n");
  out.end();
  await once(out, "finish");
}

describe("restorePostgres with a >600 MB dump", () => {
  it("hands psql the file (not a string), verifies counts by streaming, with bounded heap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-restore-big-"));
    const file = join(dir, "big.sql");
    try {
      await writeBigDump(file);
      expect(statSync(file).size).toBeGreaterThan(600 * 1024 * 1024);
      const inputs: unknown[] = [];
      const run: PgRunner = (args, input) => {
        if (args[0] === "psql" && args.includes("ON_ERROR_STOP=1")) {
          inputs.push(input);
        }
        if (args[0] === "pg_dump") return { status: 0, stdout: "-- PostgreSQL database dump complete\n", stderr: "" };
        if (args.includes("-tAc")) return { status: 0, stdout: String(ROWS), stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      };
      global.gc?.();
      const base = process.memoryUsage().heapUsed;
      let peak = 0;
      const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
      const r = await restorePostgres(file, dir, T, run);
      clearInterval(t);
      expect(r.ok).toBe(true);
      expect(r.counts?.pai_chunks).toEqual({ expected: ROWS, actual: ROWS });
      expect(inputs).toEqual([{ file }]);
      expect(peak - base).toBeLessThan(150 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("a failing psql load reports failure and leaves the live database untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-restore-big2-"));
    const file = join(dir, "big.sql");
    try {
      await writeBigDump(file);
      const calls: string[] = [];
      const run: PgRunner = (args) => {
        calls.push(args.join(" "));
        if (args.includes("ON_ERROR_STOP=1")) return { status: 3, stdout: "", stderr: "boom" };
        return { status: 0, stdout: args[0] === "pg_dump" ? "-- PostgreSQL database dump complete\n" : "", stderr: "" };
      };
      const r = await restorePostgres(file, dir, T, run);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/psql failed: boom; live database untouched/);
      expect(calls.join("\n")).not.toMatch(/RENAME/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
