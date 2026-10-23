import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsePsOutput, oldestLiveStartMs, pruneDist } from "./prune-dist.mjs";

function fixture(): string {
  const dist = mkdtempSync(join(tmpdir(), "prune-dist-"));
  for (const d of ["cli", "daemon", "daemon-mcp"]) mkdirSync(join(dist, d));
  writeFileSync(join(dist, "index.mjs"), 'import "./chunk-new.mjs";\n');
  for (const d of ["cli", "daemon", "daemon-mcp"]) writeFileSync(join(dist, d, "index.mjs"), "");
  writeFileSync(join(dist, "chunk-new.mjs"), "");
  return dist;
}
const prune = (dist: string, env: Record<string, string> = {}) =>
  spawnSync("node", ["scripts/prune-dist.mjs", dist], { encoding: "utf8", env: { ...process.env, ...env } });

/** A live process whose command line references `dist`, started `ageMs` ago. */
const liveProc = (dist: string, ageMs: number) =>
  JSON.stringify([{ startedAt: Date.now() - ageMs, command: `node ${dist}/daemon-mcp/index.mjs` }]);

describe("prune-dist", () => {
  it("keeps chunks a previous build left (a running process may still import them), removes those older than 24 h", () => {
    const dist = fixture();
    try {
      writeFileSync(join(dist, "chunk-prev.mjs"), "");
      writeFileSync(join(dist, "chunk-ancient.mjs"), "");
      const old = new Date(Date.now() - 25 * 3600_000);
      utimesSync(join(dist, "chunk-ancient.mjs"), old, old);
      prune(dist);
      expect(existsSync(join(dist, "chunk-new.mjs"))).toBe(true);
      expect(existsSync(join(dist, "chunk-prev.mjs"))).toBe(true);
      expect(existsSync(join(dist, "chunk-ancient.mjs"))).toBe(false);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("a process started 3 generations ago keeps those 3 generations and prunes older ones", () => {
    const dist = fixture();
    try {
      // Three builds happened after the process started; gen-3 was current when it started (the anchor).
      const now = Date.now();
      writeFileSync(join(dist, ".prune-manifest.json"), JSON.stringify({
        stamp: "never-matches",
        generations: [
          { builtAt: now - 1_000, chunks: ["chunk-gen3.mjs"] },
          { builtAt: now - 2_000, chunks: ["chunk-gen2.mjs"] },
          { builtAt: now - 4_000, chunks: ["chunk-gen1.mjs"] },
          { builtAt: now - 10_000, chunks: ["chunk-gen0.mjs"] },
        ],
      }));
      for (const c of ["chunk-gen3", "chunk-gen2", "chunk-gen1", "chunk-gen0"]) writeFileSync(join(dist, `${c}.mjs`), "");
      writeFileSync(join(dist, "chunk-gen3.mjs.map"), "");
      // Started 3.5 s ago: after gen-1 (4 s ago), before gen-2 (2 s ago) — anchor gen-1, keep gen-1..3.
      prune(dist, { PRUNE_DIST_PROCESSES: liveProc(dist, 3_500) });
      expect(existsSync(join(dist, "chunk-gen3.mjs"))).toBe(true);
      expect(existsSync(join(dist, "chunk-gen2.mjs"))).toBe(true);
      expect(existsSync(join(dist, "chunk-gen1.mjs"))).toBe(true);
      expect(existsSync(join(dist, "chunk-gen0.mjs"))).toBe(false);
      // Sourcemaps are pruned with their module.
      expect(existsSync(join(dist, "chunk-gen3.mjs.map"))).toBe(true);
      // The new generation was recorded for the next run.
      const manifest = JSON.parse(readFileSync(join(dist, ".prune-manifest.json"), "utf8"));
      expect(manifest.generations[0].chunks).toEqual(["chunk-new.mjs", "cli/index.mjs", "daemon-mcp/index.mjs", "daemon/index.mjs", "index.mjs"]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("no live process -> keeps current + previous only", () => {
    const dist = fixture();
    try {
      writeFileSync(join(dist, ".prune-manifest.json"), JSON.stringify({
        stamp: "never-matches",
        generations: [
          { builtAt: Date.now() - 1_000, chunks: ["chunk-gen2.mjs"] },
          { builtAt: Date.now() - 2_000, chunks: ["chunk-gen1.mjs"] },
        ],
      }));
      writeFileSync(join(dist, "chunk-gen2.mjs"), "");
      writeFileSync(join(dist, "chunk-gen1.mjs"), "");
      prune(dist, { PRUNE_DIST_PROCESSES: "[]" });
      expect(existsSync(join(dist, "chunk-gen2.mjs"))).toBe(true);
      expect(existsSync(join(dist, "chunk-gen1.mjs"))).toBe(false);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("ps failure -> nothing deleted, one warning", () => {
    const dist = fixture();
    try {
      writeFileSync(join(dist, ".prune-manifest.json"), JSON.stringify({
        stamp: "never-matches",
        generations: [{ builtAt: Date.now() - 1_000, chunks: ["chunk-old.mjs"] }],
      }));
      writeFileSync(join(dist, "chunk-old.mjs"), "");
      const old = new Date(Date.now() - 25 * 3600_000);
      utimesSync(join(dist, "chunk-old.mjs"), old, old);
      const r = prune(dist, { PRUNE_DIST_PROCESSES: "not json — ps failed" });
      expect(existsSync(join(dist, "chunk-old.mjs"))).toBe(true);
      expect(existsSync(join(dist, "chunk-new.mjs"))).toBe(true);
      expect(r.stderr).toContain("pruning nothing");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("a process started from a different path to the SAME dist dir (same dev+ino) counts as live", () => {
    const dist = fixture();
    const prev = process.env.PRUNE_DIST_PROCESSES;
    try {
      // Two generations; the live process started between them, so gen-1 is the anchor and must survive.
      const now = Date.now();
      writeFileSync(join(dist, ".prune-manifest.json"), JSON.stringify({
        stamp: "never-matches",
        generations: [
          { builtAt: now - 1_000, chunks: ["chunk-gen2.mjs"] },
          { builtAt: now - 3_000, chunks: ["chunk-gen1.mjs"] },
        ],
      }));
      writeFileSync(join(dist, "chunk-gen2.mjs"), "");
      writeFileSync(join(dist, "chunk-gen1.mjs"), "");
      // The repo is also reachable under an alias path; the MCP server was started from there,
      // so the command line never contains `dist` as a string. The injected stat resolves the
      // alias to the same device+inode as the real dist dir.
      const alias = "/alias-root/dist";
      const realStat = statSync;
      const stat = (p: string) => (p === alias ? realStat(dist) : realStat(p));
      process.env.PRUNE_DIST_PROCESSES = JSON.stringify([
        { startedAt: now - 2_000, command: `node ${alias}/daemon-mcp/index.mjs` },
      ]);
      pruneDist(dist, { stat });
      expect(existsSync(join(dist, "chunk-gen1.mjs"))).toBe(true); // anchor generation kept
      expect(existsSync(join(dist, "chunk-gen2.mjs"))).toBe(true); // newer generation kept
    } finally {
      if (prev === undefined) delete process.env.PRUNE_DIST_PROCESSES;
      else process.env.PRUNE_DIST_PROCESSES = prev;
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("parsePsOutput: lstart (locale-fixed format) and etimes fallback", () => {
    const now = Date.parse("Fri Oct 23 12:00:00 2026");
    const lstart = parsePsOutput(
      "Fri Oct 23 10:00:00 2026    node /tmp/dist/daemon-mcp/index.mjs\nThu Oct 22 09:00:00 2026    /sbin/launchd\n",
      now
    );
    expect(lstart.length).toBe(2);
    expect(lstart[0].startedAt).toBe(Date.parse("Fri Oct 23 10:00:00 2026"));
    expect(lstart[0].command).toBe("node /tmp/dist/daemon-mcp/index.mjs");
    const etimes = parsePsOutput("7200 node /tmp/dist/daemon-mcp/index.mjs\n", now);
    expect(etimes[0].startedAt).toBe(now - 7_200_000);
  });

  it("localized lstart (German locale) -> treated as a ps failure: nothing deleted, one warning", () => {
    const dist = fixture();
    const prev = process.env.PRUNE_DIST_PROCESSES;
    try {
      writeFileSync(join(dist, ".prune-manifest.json"), JSON.stringify({
        stamp: "never-matches",
        generations: [{ builtAt: Date.now() - 1_000, chunks: ["chunk-old.mjs"] }],
      }));
      writeFileSync(join(dist, "chunk-old.mjs"), "");
      const old = new Date(Date.now() - 25 * 3600_000);
      utimesSync(join(dist, "chunk-old.mjs"), old, old);
      // ps printed a live process, but with localized weekday/month names Date.parse rejects.
      const localized = "Mi. 21 Okt. 16:22:01 2026 node /x/dist/daemon-mcp/index.mjs\n";
      const calls: { args: unknown[]; opts: { env?: Record<string, string> } }[] = [];
      const exec = (cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
        calls.push({ args, opts });
        return localized; // the C-locale call still produced localized output (mocked failure)
      };
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        pruneDist(dist, { exec });
      } finally {
        spy.mockRestore();
      }
      expect(existsSync(join(dist, "chunk-old.mjs"))).toBe(true); // live generations must survive
      expect(existsSync(join(dist, "chunk-new.mjs"))).toBe(true);
      const warnings = spy.mock.calls.map((c) => String(c[0]));
      expect(warnings.length).toBe(1); // exactly one warning
      expect(warnings[0]).toContain("pruning nothing");
    } finally {
      if (prev === undefined) delete process.env.PRUNE_DIST_PROCESSES;
      else process.env.PRUNE_DIST_PROCESSES = prev;
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("the ps invocation runs with LC_ALL=C and LANG=C so lstart is English", () => {
    const dist = fixture();
    const prev = process.env.PRUNE_DIST_PROCESSES;
    try {
      const calls: { args: string[]; opts: { env?: Record<string, string> } }[] = [];
      const exec = (_cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
        calls.push({ args, opts });
        return "Fri Oct 23 10:00:00 2026    node /tmp/dist/daemon-mcp/index.mjs\n";
      };
      oldestLiveStartMs(dist, { exec });
      expect(calls.length).toBe(1);
      expect(calls[0].opts.env?.LC_ALL).toBe("C");
      expect(calls[0].opts.env?.LANG).toBe("C");
    } finally {
      if (prev === undefined) delete process.env.PRUNE_DIST_PROCESSES;
      else process.env.PRUNE_DIST_PROCESSES = prev;
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
