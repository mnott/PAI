/**
 * Importing the shared path module must never exit the host process, even on
 * a fresh machine with no ~/.claude — `pai setup` is what creates it.
 */

import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("importing pai-paths with an empty HOME does not exit", () => {
  const home = mkdtempSync(join(tmpdir(), "pai-paths-import-"));
  const env = { ...process.env, HOME: home };
  delete env.PAI_DIR;
  delete env.ADAPTER_DIR;
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", "await import('./src/hooks/ts/lib/pai-paths.ts'); console.log('ok')"],
    { env, encoding: "utf8" },
  );
  expect(r.stderr).not.toContain("not found");
  expect(r.stdout.trim()).toBe("ok");
  expect(r.status).toBe(0);
});
