import { describe, it, expect } from "vitest";
import { utimesSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error plain .mjs helper
import { reachableFrom } from "./lib/dist-reachable.mjs";

function fixture(): string {
  const dist = mkdtempSync(join(tmpdir(), "reach-"));
  for (const d of ["cli", "daemon", "daemon-mcp"]) {
    mkdirSync(join(dist, d));
    writeFileSync(join(dist, d, "index.mjs"), "");
  }
  writeFileSync(join(dist, "index.mjs"), 'import "./live-a.mjs";\n');
  writeFileSync(join(dist, "live-a.mjs"), 'export * from "./live-b.mjs";\nconst x = () => import("./live-c.mjs");\n');
  writeFileSync(join(dist, "live-b.mjs"), "");
  writeFileSync(join(dist, "live-c.mjs"), "");
  return dist;
}
// Hermetic: inject an empty process list so the real machine's processes (and ps output)
// cannot influence which generations survive — no live process -> current + previous only.
const prune = (dist: string) =>
  spawnSync("node", ["scripts/prune-dist.mjs", dist], { encoding: "utf8", env: { ...process.env, PRUNE_DIST_MAX_AGE_MS: String(24 * 3600_000), PRUNE_DIST_PROCESSES: "[]" } });

describe("reachableFrom", () => {
  it("follows static and dynamic imports from entries only; stale chunks importing each other stay unreachable", () => {
    const dist = fixture();
    try {
      writeFileSync(join(dist, "stale-1.mjs"), 'import "./stale-2.mjs";\n');
      writeFileSync(join(dist, "stale-2.mjs"), 'import "./stale-1.mjs";\nimport "./live-b.mjs";\n');
      const r = reachableFrom([join(dist, "index.mjs")]);
      expect([...r].map((p: string) => p.slice(dist.length + 1)).sort()).toEqual(["index.mjs", "live-a.mjs", "live-b.mjs", "live-c.mjs"]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("prune-dist generations", () => {
  it("keeps the previous build's chunks for one build, then deletes them even when recent, with their maps", () => {
    const dist = fixture();
    try {
      prune(dist); // manifest: gen N
      writeFileSync(join(dist, "index.mjs"), 'import "./live-b.mjs";\n'); // build N+1 drops live-a/live-c
      writeFileSync(join(dist, "stale-1.mjs"), 'import "./stale-2.mjs";\n');
      writeFileSync(join(dist, "stale-2.mjs"), 'import "./stale-1.mjs";\n');
      writeFileSync(join(dist, "live-a.mjs.map"), "");
      const t0 = new Date(Date.now() + 2000);
      utimesSync(join(dist, "index.mjs"), t0, t0);
      prune(dist);
      expect(existsSync(join(dist, "live-a.mjs"))).toBe(true); // previous generation survives
      expect(existsSync(join(dist, "stale-1.mjs"))).toBe(false); // never reachable, recent, still deleted
      expect(existsSync(join(dist, "stale-2.mjs"))).toBe(false);
      prune(dist); // same build again: previous generation still protected
      expect(existsSync(join(dist, "live-a.mjs"))).toBe(true);
      writeFileSync(join(dist, "index.mjs"), 'import "./live-b.mjs";\n// build N+2\n');
      const t = new Date(Date.now() + 5000);
      utimesSync(join(dist, "index.mjs"), t, t);
      prune(dist);
      expect(existsSync(join(dist, "live-a.mjs"))).toBe(false);
      expect(existsSync(join(dist, "live-a.mjs.map"))).toBe(false);
      expect(existsSync(join(dist, "live-b.mjs"))).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
