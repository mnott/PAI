import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(): string {
  const dist = mkdtempSync(join(tmpdir(), "prune-dist-"));
  for (const d of ["cli", "daemon", "daemon-mcp"]) mkdirSync(join(dist, d));
  writeFileSync(join(dist, "index.mjs"), 'import "./chunk-new.mjs";\n');
  for (const d of ["cli", "daemon", "daemon-mcp"]) writeFileSync(join(dist, d, "index.mjs"), "");
  writeFileSync(join(dist, "chunk-new.mjs"), "");
  return dist;
}
const prune = (dist: string) => spawnSync("node", ["scripts/prune-dist.mjs", dist], { encoding: "utf8" });

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
});
