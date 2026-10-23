import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsePsOutput } from "./prune-dist.mjs";

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
});
