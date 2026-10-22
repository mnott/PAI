/**
 * A missing aibroker binary must surface as a handled failure. Before the
 * stdin error listener, writing to the dead child's stdin raised an uncaught
 * EPIPE that killed the poller process. Run in a real child process, because
 * the test runner installs its own uncaught-exception handling.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AiBrokerTransport, AiBrokerProber } from "./aibroker.js";

const MODULE = fileURLToPath(new URL("./aibroker.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

describe("aibroker transport with a missing binary", () => {
  it("fails without an uncaught exception", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-aibroker-"));
    const script = join(dir, "run.mts");
    writeFileSync(
      script,
      `import { AiBrokerTransport, AiBrokerProber } from ${JSON.stringify(MODULE)};
process.on("uncaughtException", (e) => { console.log("UNCAUGHT " + (e as Error).message); process.exit(2); });
const t = new AiBrokerTransport("/usr/bin/true", 1);
const big = "x".repeat(2_000_000);
try { await t.dispatch("proj", big, { spawnIfAbsent: true }); console.log("NO-THROW"); }
catch (e) { console.log("REJECTED"); }
const a = await new AiBrokerProber("/nonexistent-bin-pai-test", 1).ask("proj", big);
console.log("PROBE " + a.state);
await new Promise((r) => setTimeout(r, 300));
console.log("DONE");
`,
    );
    const r = spawnSync(TSX, [script], { encoding: "utf8", timeout: 30_000 });
    expect(r.stdout).not.toContain("UNCAUGHT");
    expect(r.stdout).toContain("REJECTED");
    expect(r.stdout).toContain("PROBE silent");
    expect(r.stdout).toContain("DONE");
  });
});

describe("project names that look like options", () => {
  it("are refused before reaching the CLI", async () => {
    const t = new AiBrokerTransport("/nonexistent-bin-pai-test", 1);
    const r = await t.dispatch("--help", "m", { spawnIfAbsent: true });
    expect(r.outcome).toBe("unlaunchable");
    const a = await new AiBrokerProber("/nonexistent-bin-pai-test", 1).ask("-x", "q");
    expect(a.state).toBe("silent");
    expect(a.reason).toMatch(/invalid project/);
  });
});
