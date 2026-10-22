import { describe, expect, it } from "vitest";
import { createWriteStream, mkdtempSync, readdirSync, rmSync, statSync, writeSync, openSync, closeSync } from "node:fs";
import { writeFileSync } from "node:fs";
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
      const run: PgRunner = (args, input, output) => {
        if (args[0] === "psql" && args.includes("ON_ERROR_STOP=1")) {
          inputs.push(input);
        }
        if (args[0] === "pg_dump") { writeFileSync(output!.file, "-- PostgreSQL database dump complete\n"); return { status: 0, stdout: "", stderr: "" }; }
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
      const run: PgRunner = (args, _in, output) => {
        calls.push(args.join(" "));
        if (args.includes("ON_ERROR_STOP=1")) return { status: 3, stdout: "", stderr: "boom" };
        if (args[0] === "pg_dump") writeFileSync(output!.file, "-- PostgreSQL database dump complete\n");
        return { status: 0, stdout: "", stderr: "" };
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

/** A pg_dump stand-in that writes a ~650 MB live dump straight to the output file, optionally truncated. */
function bigLiveDump(complete: boolean): PgRunner {
  return (args, _in, output) => {
    if (args[0] === "pg_dump") {
      if (!output) throw new Error("pg_dump stdout must go to a file");
      const fd = openSync(output.file, "w");
      const row = Buffer.from(ROW);
      const chunk = Buffer.concat(Array.from({ length: 1000 }, () => row));
      writeSync(fd, "COPY public.pai_chunks (a, b) FROM stdin;\n");
      for (let i = 0; i < ROWS / 1000; i++) writeSync(fd, chunk);
      writeSync(fd, complete ? "\\.\n-- PostgreSQL database dump complete\n" : "\\.\nINSERT INTO");
      closeSync(fd);
    }
    return { status: 0, stdout: args.includes("-tAc") ? String(ROWS) : "", stderr: "" };
  };
}

describe("restorePostgres with a >600 MB live database", () => {
  it("writes and verifies the safety dump by streaming, with bounded heap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-restore-live-"));
    const file = join(dir, "small.sql");
    try {
      writeFileSync(file, "COPY public.pai_chunks (a, b) FROM stdin;\n\\.\n-- PostgreSQL database dump complete\n");
      global.gc?.();
      const base = process.memoryUsage().heapUsed;
      let peak = 0;
      const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
      const r = await restorePostgres(file, dir, T, bigLiveDump(true), { pai_chunks: ROWS });
      clearInterval(t);
      expect(r.ok).toBe(true);
      expect(statSync(r.safetyDump!).size).toBeGreaterThan(600 * 1024 * 1024);
      expect(peak - base).toBeLessThan(150 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses to restore when the big safety dump comes out incomplete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-restore-live2-"));
    const file = join(dir, "small.sql");
    try {
      writeFileSync(file, "-- PostgreSQL database dump complete\n");
      const r = await restorePostgres(file, dir, T, bigLiveDump(false));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/pre-restore dump of live database is incomplete/);
      expect(readdirSync(dir)).toEqual(["small.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
