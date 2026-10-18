import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realDeps, waitOn } from "./wait-on.js";
import { realProbeDeps, waitFile, waitUrl } from "./wait-probes.js";
import { runWait } from "./wait.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wprobe-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const capture = () => {
  const lines: string[] = [];
  return { lines, out: (l: string) => void lines.push(l) };
};

describe("wait-url", () => {
  it("exit 0 when a local server answers (404 counts), 3 when nothing listens", async () => {
    const srv = createServer((_q, r) => {
      r.statusCode = 404;
      r.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const c = capture();
      expect(await waitUrl({ url: `http://127.0.0.1:${port}/x`, maxSecs: 5 }, { ...realProbeDeps, out: c.out })).toBe(0);
      expect(c.lines[0]).toContain("HTTP 404");
    } finally {
      await new Promise((r) => srv.close(r));
    }
    const c2 = capture();
    expect(await waitUrl({ url: `http://127.0.0.1:${port}/x`, maxSecs: 1 }, { ...realProbeDeps, out: c2.out })).toBe(3);
    expect(c2.lines[0]).toContain("not yet");
  });

  it("5xx is not up; an invalid url exits 2", async () => {
    let t = 0;
    const c = capture();
    const d = { ...realProbeDeps, out: c.out, now: () => t, sleep: async (ms: number) => void (t += ms), get: async () => 503 };
    expect(await waitUrl({ url: "http://h/", maxSecs: 3 }, d)).toBe(3);
    expect(await waitUrl({ url: "nope", maxSecs: 3 }, d)).toBe(2);
  });
});

describe("wait-file", () => {
  it("0 when all exist, 3 with a line per path when one is missing", async () => {
    const d = tmp();
    const a = join(d, "a.rc");
    const b = join(d, "b.rc");
    writeFileSync(a, "0");
    const c = capture();
    expect(await waitFile({ paths: [a, b], maxSecs: 1 }, { ...realProbeDeps, out: c.out })).toBe(3);
    expect(c.lines).toContain(`exists: ${a}`);
    expect(c.lines).toContain(`missing: ${b}`);
    writeFileSync(b, "0");
    expect(await waitFile({ paths: [a, b], maxSecs: 1 }, { ...realProbeDeps, out: capture().out })).toBe(0);
  });

  it("returns as soon as a file appears mid-wait", async () => {
    const f = join(tmp(), "late");
    setTimeout(() => writeFileSync(f, "x"), 300);
    expect(await waitFile({ paths: [f], maxSecs: 5 }, { ...realProbeDeps, out: capture().out })).toBe(0);
  });
});

describe("wait-on: a zombie is a finished job", () => {
  it("exits 0 for an exited child its parent has not reaped", async () => {
    const d = tmp();
    const pidFile = join(d, "z.pid");
    // parent stays alive without reaping its child, which exits at once
    const parent = spawn(
      "perl",
      ["-e", `my $p=fork(); if(!$p){exec "true"} open F,">${pidFile}"; print F $p; close F; sleep 30`],
      { stdio: "ignore" }
    );
    try {
      await new Promise((r) => setTimeout(r, 800));
      const pid = Number(readFileSync(pidFile, "utf8"));
      const c = capture();
      const rc = await waitOn({ pid, maxSecs: 6, tail: 0 }, { ...realDeps, out: c.out });
      expect(rc, c.lines.join("|")).toBe(0);
    } finally {
      parent.kill();
    }
  });
});

describe("wait (child workers)", () => {
  const status = (id: string, state: WorkerStatus["state"]): WorkerStatus =>
    ({ id, pid: process.pid, label: id, state, rc: state === "done" ? 0 : null, secs: 1, last: "", started: nowStamp() }) as unknown as WorkerStatus;

  it("returns as soon as ANY finishes (exit 3, a line per id); all done exits 0", async () => {
    const dir = tmp();
    saveStatus(dir, status("a", "done"));
    saveStatus(dir, status("b", "running"));
    const c = capture();
    const errs = capture();
    expect(await runWait(dir, ["a", "b"], { max: 5 }, c.out, errs.out)).toBe(3);
    expect(c.lines).toHaveLength(2);
    expect(JSON.parse(c.lines[1]).state).toBe("running");
    saveStatus(dir, status("b", "done"));
    expect(await runWait(dir, ["a", "b"], { max: 5 }, capture().out, errs.out)).toBe(0);
  });

  it("max elapses with nothing finished: exit 3", async () => {
    const dir = tmp();
    saveStatus(dir, status("b", "running"));
    expect(await runWait(dir, ["b"], { max: 1 }, capture().out, capture().out)).toBe(3);
  });
});
