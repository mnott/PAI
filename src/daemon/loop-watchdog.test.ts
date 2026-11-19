import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startLoopWatchdog } from "./loop-watchdog.js";
import { timedTask } from "./slow-task.js";

describe("loop watchdog", () => {
  it("a blocked loop is reported with the running task in the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    const file = join(dir, "ledger");
    let seen: string[] | undefined;
    const stop = startLoopWatchdog({ ledgerFile: file, limitMs: 400, checkMs: 50, kill: false, onStall: (t) => (seen = t) });
    timedTask("spin-task", () => {
      const end = Date.now() + 900;
      while (Date.now() < end) { /* block the loop */ }
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(readFileSync(file, "utf8")).toMatch(/DAEMON-LOOP-STALL pid=\d+ stalledMs=\d+ tasks=spin-task action=report/);
    expect(seen).toEqual(["spin-task"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
