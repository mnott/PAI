import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findNewDuplicates, stubScan } from "./worktree.js";

const repo = join(__dirname, "..", "..");
const hasJscpd = existsSync(join(repo, "node_modules", ".bin", "jscpd"));

/** A block long enough to cross the 8-line / 70-token threshold; `tag` makes distinct clone families. */
const block = (tag: string) =>
  Array.from({ length: 4 }, (_, i) =>
    [
      `export function ${tag}${i}(items: number[], limit: number): number[] {`,
      `  const out: number[] = [];`,
      `  for (const item of items) {`,
      `    if (item > limit && item % ${i + 2} === 0) out.push(item * ${i + 3} + limit);`,
      `    else if (item < -limit) out.push(Math.abs(item) - limit);`,
      `  }`,
      `  return out.sort((a, b) => a - b);`,
      `}`,
    ].join("\n")
  ).join("\n");

describe.skipIf(!hasJscpd)("duplicate-code gate on a temp copy", () => {
  let dir: string;
  const run = (...args: string[]) => spawnSync("node", ["scripts/check-duplicates.mjs", ...args], { cwd: dir, encoding: "utf8" });
  const baseline = (): string[] => JSON.parse(readFileSync(join(dir, "scripts", "duplicates-baseline.json"), "utf8"));
  const put = (name: string, text: string) => writeFileSync(join(dir, "src", name), text);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-dupgate-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "src"));
    cpSync(join(repo, "scripts", "check-duplicates.mjs"), join(dir, "scripts", "check-duplicates.mjs"));
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, "scripts", "duplicates-baseline.json"), "[]\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a new clone above the threshold fails the gate and is reported by findNewDuplicates", () => {
    put("a.ts", block("alpha"));
    expect(run().status).toBe(0);
    expect(findNewDuplicates(dir)).toBeNull();
    put("b.ts", block("alpha"));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/new clone/);
    expect(findNewDuplicates(dir)).toMatch(/new clone.*src\/a\.ts.*src\/b\.ts/);
  });

  it("a baselined clone passes; only a different new clone fails; --prune only shrinks", () => {
    expect(run("--init").status).toBe(0);
    expect(baseline().length).toBeGreaterThan(0);
    expect(run().status).toBe(0);
    expect(findNewDuplicates(dir)).toBeNull();

    put("c.ts", block("beta"));
    put("d.ts", block("beta"));
    expect(run().status).toBe(1);
    const before = baseline();
    expect(run("--prune").status).toBe(0);
    expect(baseline()).toEqual(before); // the new clone is not added by --prune
    expect(run().status).toBe(1);

    rmSync(join(dir, "src", "b.ts"));
    rmSync(join(dir, "src", "d.ts"));
    rmSync(join(dir, "src", "c.ts"));
    expect(run("--prune").status).toBe(0);
    expect(baseline().length).toBeLessThan(before.length); // the fixed alpha clone is dropped
    expect(run().status).toBe(0);
    // child process (jscpd x6) under parallel load: 1.7s alone, 2.9s in batch, so 3x the batch time
  }, 9000);
});

describe("duplicate gate fails closed when the scan cannot run", () => {
  let dir: string;
  let oldHead: string;
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" }).stdout.trim();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-dupgate-closed-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "src"));
    cpSync(join(repo, "scripts", "check-duplicates.mjs"), join(dir, "scripts", "check-duplicates.mjs"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    oldHead = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "work");
  });
  afterAll(() => {
    delete process.env.PAI_MERGE_ALLOW_DUPLICATES;
    rmSync(dir, { recursive: true, force: true });
  });

  it("the script exits 2 when the jscpd binary cannot be resolved", () => {
    const r = spawnSync("node", ["scripts/check-duplicates.mjs"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PAI_JSCPD_BIN: join(dir, "no-such-jscpd") },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not run: jscpd is not installed/);
  });

  it("findNewDuplicates reports the reason and the repair; the gate reverts and keeps the branch", () => {
    delete process.env.PAI_MERGE_ALLOW_DUPLICATES;
    expect(findNewDuplicates(dir)).toMatch(/^duplicate gate could not run: jscpd is not installed \(npm install\) — run npm install in /);
    expect(() => stubScan(dir, oldHead)).toThrow(/duplicate gate could not run:.*reverted/);
    expect(git("log", "-1", "--format=%s")).toMatch(/^Revert/);
  });

  it("PAI_MERGE_ALLOW_DUPLICATES=1 overrides", () => {
    process.env.PAI_MERGE_ALLOW_DUPLICATES = "1";
    expect(() => stubScan(dir, oldHead)).not.toThrow();
  });
});
