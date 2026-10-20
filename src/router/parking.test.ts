import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../daemon/config.js";
import { durationP50, overallP50, recordDuration } from "../builds/durations.js";
import type { BuildTicket } from "../builds/queue.js";
import { NO_SAVE_PATH, Parker, parkConfigFrom, type ParkConfig } from "./parking.js";
import { DEFAULT_SCHED, RequestScheduler } from "./scheduler.js";
import { UsageSniffer } from "./usage.js";

const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

/** Fake Strata: slot save/restore, files remembered by name; savePath=false answers 501. */
async function fakeEngine(opts: { savePath?: boolean; saveStatus?: number } = {}) {
  const calls: string[] = [];
  const files = new Set<string>();
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const action = new URL(req.url!, "http://x").searchParams.get("action");
      const name = (JSON.parse(b || "{}") as { filename?: string }).filename ?? "";
      calls.push(`${action} ${name}`);
      const send = (code: number) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end("{}");
      };
      if (opts.savePath === false) return send(501);
      if (action === "save") {
        if (opts.saveStatus) return send(opts.saveStatus);
        files.add(name);
        return setTimeout(() => send(200), 20);
      }
      return files.has(name) ? send(200) : send(404);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return { origin: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, calls, files };
}

const post = async (url: string, body: unknown) => {
  const t0 = Date.now();
  const r = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, ms: Date.now() - t0 };
};

function rig(cfg: Partial<ParkConfig> = {}, tickets: BuildTicket[] = [], durations: Record<string, number[]> = { k: [200, 300, 250] }) {
  const dir = mkdtempSync(join(tmpdir(), "park-"));
  for (const [k, xs] of Object.entries(durations)) for (const x of xs) recordDuration(dir, k, x);
  const log: string[] = [];
  const parker = new Parker(() => ({ enabled: true, parkAfterSec: 120, ...cfg }), {
    dir,
    buildsDir: dir,
    tickets: () => tickets,
    cachePressure: () => false,
    post,
    log: (l) => log.push(l),
  });
  return { parker, log };
}

describe("durations", () => {
  it("keeps per-key p50 and overall median", () => {
    const dir = mkdtempSync(join(tmpdir(), "dur-"));
    for (const s of [10, 30, 20]) recordDuration(dir, "a", s);
    recordDuration(dir, "b", 100);
    expect(durationP50(dir, "a")).toBe(20);
    expect(durationP50(dir, "zz")).toBeUndefined();
    expect(overallP50(dir)).toBe(60);
  });
});

describe("parkConfigFrom", () => {
  it("defaults off, 120 s", () => {
    expect(parkConfigFrom(undefined)).toEqual({ enabled: false, parkAfterSec: 120 });
    expect(parkConfigFrom({ enabled: true, parkAfterSec: 60 })).toEqual({ enabled: true, parkAfterSec: 60 });
  });
});

describe("UsageSniffer buildCall", () => {
  it("sees `pai build run` split across tool-input deltas", () => {
    const sn = new UsageSniffer("text/event-stream");
    const ev = (j: string) => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: j } })}\n\n`;
    sn.push(Buffer.from(ev('{"command": "cd x && pai bu')));
    sn.push(Buffer.from(ev('ild run -- make"}')));
    sn.finish();
    expect(sn.buildCall).toBe(true);
    const other = new UsageSniffer("text/event-stream");
    other.push(Buffer.from(ev('{"command": "ls"}')));
    expect(other.buildCall).toBe(false);
  });
});

describe("Parker", () => {
  it("parks a long-build worker under pressure and restores before its next request", async () => {
    const eng = await fakeEngine();
    const { parker, log } = rig();
    parker.noteEngine("gyro", eng.origin);
    await parker.maybePark("gyro", "w1", 1);
    expect(eng.calls).toEqual(["restore pai-park-probe-none.bin", "save w1.bin"]);
    expect(Object.keys(parker.parkedWorkers())).toEqual(["w1"]);
    await parker.restoreIfParked("gyro", "w1", "w2");
    expect(eng.calls.at(-1)).toBe("restore w1.bin");
    expect(parker.parkedWorkers()).toEqual({});
    expect(log.join("\n")).toMatch(/restored w1/);
  });

  it("does not park without pressure, with a short build, or when disabled", async () => {
    const eng = await fakeEngine();
    const a = rig();
    a.parker.noteEngine("gyro", eng.origin);
    await a.parker.maybePark("gyro", "w1", 0);
    const b = rig({}, [], { k: [30, 40] });
    b.parker.noteEngine("gyro", eng.origin);
    await b.parker.maybePark("gyro", "w1", 2);
    const c = rig({ enabled: false });
    c.parker.noteEngine("gyro", eng.origin);
    await c.parker.maybePark("gyro", "w1", 2);
    expect(eng.calls).toEqual([]);
  });

  it("uses the ticket's key history", async () => {
    const eng = await fakeEngine();
    const t = { worker: "w1", key: "short" } as BuildTicket;
    const { parker } = rig({}, [t], { short: [20, 30], long: [500] });
    parker.noteEngine("gyro", eng.origin);
    await parker.maybePark("gyro", "w1", 1);
    expect(eng.calls).toEqual([]);
  });

  it("reports a missing slot save path and parks nothing", async () => {
    const eng = await fakeEngine({ savePath: false });
    const { parker, log } = rig();
    parker.noteEngine("gyro", eng.origin);
    expect(await parker.checkParking(eng.origin)).toBe(NO_SAVE_PATH);
    await parker.maybePark("gyro", "w1", 1);
    expect(parker.parkedWorkers()).toEqual({});
    expect(eng.calls.some((c) => c.startsWith("save"))).toBe(false);
    expect(log.filter((l) => l.includes(NO_SAVE_PATH))).toHaveLength(1);
  });

  it("a failed save leaves the worker unparked; a failed restore falls back and logs", async () => {
    const eng = await fakeEngine({ saveStatus: 500 });
    const { parker, log } = rig();
    parker.noteEngine("gyro", eng.origin);
    await parker.maybePark("gyro", "w1", 1);
    expect(parker.parkedWorkers()).toEqual({});
    expect(log.join("\n")).toMatch(/save answered 500/);
    const ok = await fakeEngine();
    const r = rig();
    r.parker.noteEngine("gyro", ok.origin);
    await r.parker.maybePark("gyro", "w1", 1);
    ok.files.clear();
    await r.parker.restoreIfParked("gyro", "w1", "w2");
    expect(r.log.join("\n")).toMatch(/restore w1: answered 404; re-reading/);
  });

  it("skips the restore when the slot still holds the worker", async () => {
    const eng = await fakeEngine();
    const { parker } = rig();
    parker.noteEngine("gyro", eng.origin);
    await parker.maybePark("gyro", "w1", 1);
    const n = eng.calls.length;
    await parker.restoreIfParked("gyro", "w1", "w1");
    expect(eng.calls.length).toBe(n);
  });
});

describe("router.parking values from config", () => {
  it("parkAfterSec from a user config changes when a worker gets parked", async () => {
    // A temp PAI_HOME/config.yaml (PAI_CONFIG_FILE, never the live files): the
    // shipped defaults merged under it, read through loadConfig → parkConfigFrom.
    const savedHome = process.env.PAI_HOME;
    const savedFile = process.env.PAI_CONFIG_FILE;
    const cfgDir = mkdtempSync(join(tmpdir(), "park-cfg-"));
    process.env.PAI_HOME = cfgDir;
    process.env.PAI_CONFIG_FILE = join(cfgDir, "config.yaml");
    writeFileSync(process.env.PAI_CONFIG_FILE, "router:\n  parking:\n    enabled: true\n    parkAfterSec: 10\n");
    try {
      const eng = await fakeEngine();
      // the build's p50 is 25 s: over the configured 10 s, under the default 120 s
      const { parker } = rig(parkConfigFrom(loadConfig().router.parking));
      parker.noteEngine("gyro", eng.origin);
      await parker.maybePark("gyro", "w1", 1);
      expect(eng.calls.some((c) => c.startsWith("save w1.bin"))).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.PAI_HOME;
      else process.env.PAI_HOME = savedHome;
      if (savedFile === undefined) delete process.env.PAI_CONFIG_FILE;
      else process.env.PAI_CONFIG_FILE = savedFile;
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });
});

describe("scheduler idle hook", () => {
  it("holds the engine through the save, then admits the waiter", async () => {
    const s = new RequestScheduler(() => DEFAULT_SCHED);
    const events: string[] = [];
    let finish!: () => void;
    s.idleHook = (_e, w, n) => {
      events.push(`hook ${w} ${n}`);
      return new Promise<void>((r) => (finish = r));
    };
    const t1 = await s.acquire("eng", "s1", "w1");
    void s.acquire("eng", "s2", "w2").then(() => events.push("w2 granted"));
    t1.release({ prefill: 1, decode: 1 }, { gate: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["hook w1 1"]);
    expect(s.slotHolder("eng")).toBe("w1");
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["hook w1 1", "w2 granted"]);
  });

  it("no hook without the gate flag", async () => {
    const s = new RequestScheduler(() => DEFAULT_SCHED);
    let called = false;
    s.idleHook = async () => void (called = true);
    const t1 = await s.acquire("eng", "s1", "w1");
    t1.release();
    expect(called).toBe(false);
  });
});
