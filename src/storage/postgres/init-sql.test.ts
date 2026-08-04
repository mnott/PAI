import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `docker/init.sql` must survive packaging.
 *
 * `backend.ts` reads it to create the Postgres schema the first time it sees a
 * database without `pai_chunks`. It is NOT in `dist/`, so it only reaches a user
 * if `files` in package.json lists it — and `files` is a whitelist, so a runtime
 * resource outside dist/ is dropped by default and nothing complains.
 *
 * Verified on the published 0.32.0 tarball: `package/docker` did not exist. So a
 * clean `npm install` shipped a first-run schema step that could not possibly
 * work, and it went unnoticed because every developer runs from a git checkout
 * where the file is simply there. The AIBroker session found the identical defect
 * in its own package the same day — `docker/compose.yml` missing from a published
 * `ota` command — which is what prompted looking here.
 *
 * This test guards the whitelist rather than the file: the file is not going
 * anywhere, the whitelist entry is what a future reshuffle drops.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("the Postgres schema ships", () => {
  it("exists in the repo where backend.ts looks for it", () => {
    expect(existsSync(join(repoRoot, "docker", "init.sql"))).toBe(true);
  });

  it("is listed in package.json files, or npm will not publish it", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      files: string[];
    };
    // Either the file itself or the whole directory satisfies this.
    const covered = pkg.files.some(
      (f) => f === "docker/init.sql" || f === "docker" || f === "docker/"
    );
    expect(covered, `package.json files: ${JSON.stringify(pkg.files)}`).toBe(true);
  });

  it("actually contains the schema, not a placeholder", () => {
    // A present-but-empty file would satisfy the checks above and still fail at
    // first init — "exists" is not "is what it claims to be".
    const sql = readFileSync(join(repoRoot, "docker", "init.sql"), "utf8");
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/i);
    expect(sql).toMatch(/pai_chunks/);
  });
});
