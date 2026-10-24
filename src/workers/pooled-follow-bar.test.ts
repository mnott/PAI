import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOwnedPane, runPaneExec } from "./pane-exec.js";
import { pooledFollowSpawn } from "./run/pane-handles.js";

describe("pane of a pooled run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pai-pfb-"));
    process.env.PAI_HOME = join(dir, "home");
  });
  afterEach(() => {
    delete process.env.PAI_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks the wrapper for the status line and the input line", () => {
    const o = pooledFollowSpawn("w1", "lbl", "/logs", "/cwd");
    expect(o.statusLine).toEqual({ kind: "worker", id: "w1", logDir: "/logs" });
  });

  it("the wrapper draws the status row and the input row around the follow output", async () => {
    const shown: string[] = [];
    const p = await openOwnedPane({
      id: "t-pfb", kind: "worker", helloMs: 5000,
      open: async () => {
        void runPaneExec("t-pfb", { out: (s) => shown.push(String(s)), err: (s) => shown.push(String(s)), tty: true, proc: new EventEmitter() as NodeJS.Process, bar: { rows: () => 24, columns: () => 80, input: Object.assign(new PassThrough(), { isTTY: false }), onResize: undefined, loadStatus: () => null } });
        return "fake";
      },
    });
    const o = pooledFollowSpawn("w1", "lbl", dir, dir);
    const proc = await p.start({ argv: ["/bin/sh", "-c", "echo followed"], statusLine: o.statusLine });
    await new Promise((r) => proc.on("close", r));
    const all = shown.join("");
    expect(all).toContain("followed");
    expect(all).toContain("w1");
  });
});
