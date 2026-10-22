import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
// vi.mock factories are hoisted above the imports; the stub lives here
const stubbedQueueDir = { current: "" };
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
      // one ticket of the stubbed queue dir fails with ENOENT after the listing named it
      if (stubbedQueueDir.current && String(file).startsWith(join(stubbedQueueDir.current, "w-002"))) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT" });
      }
      return (fs.readFileSync as (...a: unknown[]) => unknown)(file, ...rest) as never;
    },
  };
});
import { capacityGate, effectiveCap, fairOrder, liveQueue, moveUp, providerCap, queueRows, queuedText, reorderQueue, reorderQueueTo, resolveCap, setFront, type CapacityConfig, type CapacityInfo } from "./capacity.js";
import { defaultWorkersConfig, readWorkersSection } from "./config.js";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const DEAD = 999999;
const st = (id: string, over: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, pid: 100, provider: "p", state: "running", turns: 0, origin: "spawn", ...over }) as WorkerStatus;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function harness(statuses: (elapsedMs: number) => WorkerStatus[], self: string, cap: number | undefined = 3) {
  const logDir = mkdtempSync(join(tmpdir(), "cap-"));
  dirs.push(logDir);
  let t = 0;
  const lines: string[] = [];
  const waits: (CapacityInfo | null)[] = [];
  const base = {
    logDir,
    self: { id: self, provider: "p", pid: 200 },
    cap,
    config: defaultWorkersConfig().capacity,
    log: (l: string) => lines.push(l),
    onWait: (w: CapacityInfo | null) => waits.push(w),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      // an injected sleep resolves at once, so a gate nobody frees would spin the event loop forever
      if (t > 3_600_000) throw new Error("harness: the gate was never released within one virtual hour");
    },
    load: () => statuses(t),
    isAlive: (pid: number) => pid !== DEAD,
  };
  return { base, lines, waits, elapsed: () => t, advance: (ms: number) => (t += ms) };
}

// CONFIG_FILE and workersYamlPath() resolve once at module load, so the temp
// PAI_HOME must exist BEFORE those modules are first imported (the trick of
// shipped-defaults.test.ts): each case writes its user workers.yaml there and
// reads it through readWorkersSection.
const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
const savedConfigFile = process.env.PAI_CONFIG_FILE;
const savedWorkersYaml = process.env.PAI_WORKERS_YAML;
const cfgDirs: string[] = [];
let cfgHome: string;
let cfgYamlPath: string;

beforeAll(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "cap-home-"));
  cfgDirs.push(process.env.HOME!);
  cfgHome = mkdtempSync(join(tmpdir(), "cap-paihome-"));
  cfgDirs.push(cfgHome);
  process.env.PAI_HOME = cfgHome;
  process.env.PAI_CONFIG_FILE = join(cfgHome, "config.json");
  cfgYamlPath = join(cfgHome, "workers.yaml");
  process.env.PAI_WORKERS_YAML = cfgYamlPath;
});

afterAll(() => {
  while (cfgDirs.length) rmSync(cfgDirs.pop()!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
  if (savedWorkersYaml === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedWorkersYaml;
});

/** The user's config.yaml (a temp PAI_HOME, never the live files) with one
 *  `workers.capacity` key set; the shipped defaults merge under it. */
function userCapacity(yaml: string): CapacityConfig {
  const configPath = join(cfgHome, "config.yaml");
  writeFileSync(configPath, yaml);
  try {
    return readWorkersSection(undefined, () => undefined).workers.capacity;
  } finally {
    rmSync(configPath, { force: true });
  }
}

describe("workers.capacity values from config", () => {
  it("localDefaultCap from a user config changes the loopback cap", () => {
    const capacity = userCapacity("workers:\n  capacity:\n    localDefaultCap: 2\n");
    expect(capacity.localDefaultCap).toBe(2);
    expect(resolveCap(undefined, true, capacity.localDefaultCap)).toBe(2); // not the default 1
    expect(providerCap({ providers: { p: { baseUrl: "http://127.0.0.1:8035" } }, capacity }, "p")).toBe(2);
  });

  it("uncappedQueueCap from a user config changes the cap of an uncapped provider", () => {
    const capacity = userCapacity("workers:\n  capacity:\n    uncappedQueueCap: 7\n");
    expect(capacity.uncappedQueueCap).toBe(7);
    expect(effectiveCap(undefined, false, undefined, capacity)).toBe(7); // not the default 3
  });

  it("maxTotalWaitMs from a user config raises the alarm at the configured wait", async () => {
    const capacity = userCapacity("workers:\n  capacity:\n    maxTotalWaitMs: 5000\n");
    expect(capacity.maxTotalWaitMs).toBe(5_000);
    // cap 1: three holders keep the gate waiting, so the alarm can fire; they
    // free their slots one by one, so the gate ends instead of looping
    const h = harness((ms) => [
      st("a", { state: ms >= 2000 ? "done" : "running", started: ms >= 2000 ? "2020-01-01 00:00:00" : nowStamp(), pid: ms >= 2000 ? DEAD : 100 }),
      st("b", { state: ms >= 4000 ? "done" : "running", started: ms >= 4000 ? "2020-01-01 00:00:00" : nowStamp(), pid: ms >= 4000 ? DEAD : 100 }),
      st("c", { state: ms >= 6000 ? "done" : "running", started: ms >= 6000 ? "2020-01-01 00:00:00" : nowStamp(), pid: ms >= 6000 ? DEAD : 100 }),
      st("d", { state: ms >= 6000 ? "done" : "running", started: ms >= 6000 ? "2020-01-01 00:00:00" : nowStamp(), pid: ms >= 6000 ? DEAD : 100 }),
    ], "self", 1);
    let alarmed = 0;
    // no alarmMs override: the gate's own bound must come from the config
    const r = await capacityGate({ ...h.base, cap: 1, config: capacity, onAlarm: () => alarmed++ });
    expect(r).not.toBeNull();
    expect(alarmed).toBe(1); // at the configured 5 s, not the default 2 h
  });

  it("heartbeatMs from a user config beats the log at the configured interval", async () => {
    const capacity = userCapacity("workers:\n  capacity:\n    heartbeatMs: 1000\n");
    expect(capacity.heartbeatMs).toBe(1_000);
    const h = harness((elapsed) => ["a", "b", "c", "d"].map((id) => (elapsed > 5000 ? st(id, { state: "done", pid: DEAD }) : st(id))), "self");
    await capacityGate({ ...h.base, cap: 1, config: capacity });
    expect(h.lines.filter((l) => l.includes("still waiting")).length).toBeGreaterThanOrEqual(1); // beats at 1 s, not the default 60 s
  });

  it("agingMs from a user config ages a ticket ahead at the configured bound", () => {
    const capacity = userCapacity("workers:\n  capacity:\n    agingMs: 300000\n");
    expect(capacity.agingMs).toBe(300_000);
    const now = 10_000_000;
    const entries = [
      { id: "a1", pid: 1, front: false, since: now - capacity.agingMs - 1 },
      { id: "b1", pid: 1, front: false, since: now - 1000 },
    ];
    const order = fairOrder({ entries, sessionOf: (id) => (id.startsWith("a") ? "A" : "B"), running: [], now, agingMs: capacity.agingMs });
    expect(order.map((e) => e.id)).toEqual(["a1", "b1"]); // aged at 5 min, not the default 15
  });
});

describe("capacityGate", () => {
  it("queues the 4th run behind 3 live ones and releases when one ends", async () => {
    const h = harness(
      (ms) => [st("a"), st("b"), st("c", { state: ms >= 1000 ? "done" : "running" }), st("d")],
      "d",
    );
    const r = await capacityGate(h.base);
    expect(r?.cap).toBe(3);
    expect(h.lines[0]).toBe("queued: 4 on p, cap 3 (position 1)");
    expect(h.waits[0]).toMatchObject({ provider: "p", cap: 3, total: 4, position: 1 });
    expect(h.waits.at(-1)).toBeNull();
    expect(h.elapsed()).toBeGreaterThanOrEqual(1000);
    expect(h.elapsed()).toBeLessThan(2500);
    expect(liveQueue(h.base.logDir, "p", h.base.isAlive)).toEqual([]);
  });

  it("logs a heartbeat at least every 60 s while queued", async () => {
    const h = harness(() => [st("a"), st("b"), st("c", { state: "done" })].map((x, i) => (i === 2 ? st("c", { state: "running" }) : x)), "d");
    let sleeps = 0;
    const sleep = async (ms: number) => {
      await h.base.sleep(ms === 2000 ? 20_000 : ms);
      if (++sleeps > 12) throw new Error("stop");
    };
    await expect(capacityGate({ ...h.base, sleep })).rejects.toThrow("stop");
    const beats = h.lines.filter((l) => l.startsWith("queued: still waiting"));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0]).toMatch(/^queued: still waiting, position 1, \d+s$/);
  });

  it("does not wait below the cap", async () => {
    const h = harness(() => [st("a"), st("b")], "c");
    expect(await capacityGate(h.base)).toBeNull();
    expect(h.elapsed()).toBe(0);
  });

  it("releases queued runs FIFO: a free slot does not let z pass an earlier queued x", async () => {
    const h = harness(() => [st("a"), st("b")], "z");
    const qdir = join(h.base.logDir, "queue", "p");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "x"), "300"); // earlier queued run, alive
    let sleeps = 0;
    const sleep = async (ms: number) => {
      await h.base.sleep(ms);
      if (++sleeps === 3) writeFileSync(join(qdir, "x"), String(DEAD)); // x dies, z becomes head
    };
    await capacityGate({ ...h.base, sleep });
    expect(h.lines[0]).toBe("queued: 4 on p, cap 3 (position 2)");
    expect(sleeps).toBe(3);
    expect(h.waits.at(-1)).toBeNull();
  });

  it("skips the stale queue entry of a dead run", async () => {
    const h = harness(() => [st("a"), st("b")], "c");
    const qdir = join(h.base.logDir, "queue", "p");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "a0"), String(DEAD));
    expect(await capacityGate(h.base)).toBeNull();
    expect(liveQueue(h.base.logDir, "p", h.base.isAlive)).toEqual([]);
  });

  it("is unlimited for a remote provider without maxConcurrent", async () => {
    expect(resolveCap(undefined, false)).toBeUndefined();
    expect(resolveCap(undefined, true)).toBe(1);
    expect(resolveCap(5, false)).toBe(5);
    const h = harness(() => Array.from({ length: 10 }, (_, i) => st(`r${i}`)), "z");
    expect(await capacityGate({ ...h.base, cap: resolveCap(undefined, false) })).toBeNull();
    expect(h.elapsed()).toBe(0);
  });

  it("is bypassed by disabled (--no-queue) and config", async () => {
    const live = () => [st("a"), st("b"), st("c")];
    expect(await capacityGate({ ...harness(live, "d").base, disabled: true })).toBeNull();
    expect(await capacityGate({ ...harness(live, "d").base, config: { enabled: false } })).toBeNull();
  });

  it("a queued run is never counted as a slot holder", async () => {
    // three live statuses on p, one of them "queued": only two hold slots, so
    // a fourth run at cap 3 passes without waiting
    const h = harness(() => [st("a"), st("b"), st("c", { state: "queued" })], "d");
    expect(await capacityGate(h.base)).toBeNull();
    expect(h.elapsed()).toBe(0);
  });
});

describe("queue pull-forward", () => {
  // two fake waiters behind one holder: the one pulled to front gets the slot
  const qharness = () => {
    const logDir = mkdtempSync(join(tmpdir(), "cap-order-"));
    dirs.push(logDir);
    const qdir = join(logDir, "queue", "p");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "w-early"), String(process.pid));
    writeFileSync(join(qdir, "w-late"), String(process.pid));
    // alive and running: holds the only slot
    saveStatus(logDir, { id: "holder", pid: process.pid, provider: "p", state: "running", started: nowStamp(), updated: nowStamp(), label: "h", cwd: "/", term: "", model: "m", turns: 0, tools: 0, last: "", rc: null, secs: null } as WorkerStatus);
    return { logDir, qdir };
  };

  it("front moves a waiting worker ahead of an earlier one in liveQueue", () => {
    const { logDir } = qharness();
    expect(liveQueue(logDir, "p")).toEqual(["w-early", "w-late"]);
    reorderQueue(logDir, "p", "w-late", "front");
    expect(liveQueue(logDir, "p")).toEqual(["w-late", "w-early"]);
  });

  it("up moves one place; at the head it is a no-op", () => {
    const { logDir } = qharness();
    reorderQueue(logDir, "p", "w-late", "up");
    expect(liveQueue(logDir, "p")).toEqual(["w-late", "w-early"]);
    expect(reorderQueue(logDir, "p", "w-late", "up")).toEqual(["w-late", "w-early"]);
  });

  it("the moved waiter gets the slot first: capacityGate releases in the new order", async () => {
    const { logDir, qdir } = qharness();
    // w-late (id-sorted last) is pulled to front while it polls; the holder ends later
    let t = 0;
    const r = await capacityGate({
      logDir,
      self: { id: "w-late", provider: "p", pid: process.pid },
      cap: 1,
      config: defaultWorkersConfig().capacity,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (t > 60_000) throw new Error("never released");
        if (t === 250) setFront(logDir, "p", "w-late");
        if (t >= 750) saveStatus(logDir, { ...loadStatus(logDir, "holder")!, state: "done" });
      },
    });
    expect(r).not.toBeNull(); // it did wait for the holder
    // w-late got the slot ahead of the earlier w-early: its entry is gone, w-early's stays
    expect(liveQueue(logDir, "p")).toEqual(["w-early"]);
    expect(qdir).toContain("queue");
  });

  it("without the move the same gate keeps waiting (the FIFO baseline)", async () => {
    const { logDir } = qharness();
    let t = 0;
    let sleeps = 0;
    await expect(
      capacityGate({
        logDir,
        self: { id: "w-late", provider: "p", pid: process.pid },
        cap: 1,
        config: defaultWorkersConfig().capacity,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
          if (++sleeps > 6) throw new Error("stop"); // never released: w-early stays ahead
        },
      })
    ).rejects.toThrow("stop");
  });

  it("front/up throw for a worker that is not waiting", () => {
    const { logDir } = qharness();
    expect(() => reorderQueue(logDir, "p", "holder", "front")).toThrow(/not queued/);
    expect(() => reorderQueue(logDir, "p", "nosuch", "up")).toThrow(/not queued/);
  });

  it("queueRows lists waiters per provider in grant order with position and cap", () => {
    const { logDir } = qharness();
    setFront(logDir, "p", "w-late");
    const rows = queueRows(logDir, { p: 1 });
    expect(rows.map((r) => [r.id, r.position, r.queued, r.cap])).toEqual([
      ["w-late", 1, 2, 1],
      ["w-early", 2, 2, 1],
    ]);
    expect(rows[0].status?.label).toBeUndefined(); // no status file for w-late
    expect(queueRows(join(logDir, "empty"), {})).toEqual([]);
  });

  it("queueRows takes the caller's statuses instead of rereading every status file", () => {
    const { logDir } = qharness();
    const rows = queueRows(logDir, { p: 1 }, undefined, []);
    expect(rows.map((r) => r.id).sort()).toEqual(["w-early", "w-late"]);
    expect(rows.every((r) => r.status === undefined)).toBe(true);
  });

  it("providerCap resolves maxConcurrent and the loopback default", () => {
    const config = {
      providers: {
        cloud: { maxConcurrent: 5, baseUrl: "https://api.example.com" },
        plain: { baseUrl: "https://api.example.com" },
        local: { baseUrl: "http://127.0.0.1:8034" },
      },
    };
    expect(providerCap(config, "cloud")).toBe(5);
    expect(providerCap(config, "plain")).toBeUndefined();
    expect(providerCap(config, "local")).toBe(1);
    expect(providerCap(config, "gone")).toBeUndefined();
  });
});

describe("queue priority", () => {
  it("a run marked front waits ahead of older queued runs", () => {
    const logDir = mkdtempSync(join(tmpdir(), "cap-"));
    dirs.push(logDir);
    const q = join(logDir, "queue", "p");
    mkdirSync(q, { recursive: true });
    writeFileSync(join(q, "w-001"), "100");
    writeFileSync(join(q, "w-002"), "100");
    writeFileSync(join(q, "w-003"), "100 front");
    expect(liveQueue(logDir, "p", () => true)).toEqual(["w-003", "w-001", "w-002"]);
  });
});

describe("setFront / moveUp", () => {
  const setup = () => {
    const logDir = mkdtempSync(join(tmpdir(), "cap-"));
    dirs.push(logDir);
    const q = join(logDir, "queue", "p");
    mkdirSync(q, { recursive: true });
    for (const id of ["w-001", "w-002", "w-003"]) writeFileSync(join(q, id), "100");
    return logDir;
  };
  const yes = () => true;
  it("setFront puts a waiting run ahead of the rest; unknown id is false", () => {
    const dir = setup();
    expect(setFront(dir, "p", "w-003", yes)).toBe(true);
    expect(liveQueue(dir, "p", yes)).toEqual(["w-003", "w-001", "w-002"]);
    expect(setFront(dir, "p", "w-nope", yes)).toBe(false);
  });
  it("moveUp moves one place; first place is a no-op", () => {
    const dir = setup();
    expect(moveUp(dir, "p", "w-003", yes)).toBe(true);
    expect(liveQueue(dir, "p", yes)).toEqual(["w-001", "w-003", "w-002"]);
    expect(moveUp(dir, "p", "w-003", yes)).toBe(true);
    expect(liveQueue(dir, "p", yes)).toEqual(["w-003", "w-001", "w-002"]);
    expect(moveUp(dir, "p", "w-003", yes)).toBe(false);
  });
  it("moveUp past a front run joins the front group; a later --now run goes behind it", () => {
    const dir = setup();
    setFront(dir, "p", "w-001", yes);
    expect(moveUp(dir, "p", "w-002", yes)).toBe(true);
    expect(liveQueue(dir, "p", yes)).toEqual(["w-002", "w-001", "w-003"]);
    writeFileSync(join(dir, "queue", "p", "w-004"), "100 front");
    expect(liveQueue(dir, "p", yes)).toEqual(["w-002", "w-001", "w-004", "w-003"]);
  });
});

describe("waiting since", () => {
  it("survives front/up/move: since is written at enqueue and kept", () => {
    const logDir = mkdtempSync(join(tmpdir(), "cap-since-"));
    dirs.push(logDir);
    const qdir = join(logDir, "queue", "p");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "w-early"), `${process.pid} @1000`);
    writeFileSync(join(qdir, "w-late"), `${process.pid} @2000`);
    reorderQueue(logDir, "p", "w-late", "front");
    reorderQueue(logDir, "p", "w-early", "up");
    reorderQueueTo(logDir, "p", "w-late", 2);
    const rows = queueRows(logDir);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.since]))).toEqual({ "w-early": 1000, "w-late": 2000 });
  });

  it("capacityGate stamps the entry with the time it started waiting", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "cap-since2-"));
    dirs.push(logDir);
    const holder = { id: "holder", pid: process.pid, provider: "p", state: "running", started: nowStamp(), updated: nowStamp(), label: "the holder", cwd: "/", term: "", model: "m", turns: 0, tools: 0, last: "", rc: null, secs: null } as WorkerStatus;
    let t = 5000;
    const seen: Array<{ since: number | undefined; text: string }> = [];
    await capacityGate({
      logDir,
      self: { id: "w", provider: "p", pid: process.pid },
      cap: 1,
      config: defaultWorkersConfig().capacity,
      now: () => t,
      sleep: async () => {
        t += 60_000;
      },
      load: () => (t > 70_000 ? [] : [holder]),
      onWait: (w) => {
        if (!w) return;
        seen.push({ since: queueRows(logDir)[0]?.since, text: queuedText(w) });
      },
    });
    expect(seen.every((s) => s.since === 5000)).toBe(true);
    expect(seen[0].text).toMatch(/^queued on p: position 1 of 1, behind the holder — waiting since \d\d:\d\d$/);
  });

  it("a ticket deleted between the listing and the read is skipped, not an error", () => {
    // the bug: another run was stopped and its ticket file vanished between
    // readdirSync and the read; the waiter crashed with ENOENT instead of
    // skipping the entry. The module-level fs stub makes the read of w-002
    // fail with ENOENT while the listing still names it.
    const logDir = mkdtempSync(join(tmpdir(), "cap-race-"));
    dirs.push(logDir);
    const q = join(logDir, "queue", "p");
    mkdirSync(q, { recursive: true });
    writeFileSync(join(q, "w-001"), `${process.pid}`);
    writeFileSync(join(q, "w-002"), `${process.pid}`);
    stubbedQueueDir.current = q;
    try {
      expect(liveQueue(logDir, "p")).toEqual(["w-001"]);
      expect(queueRows(logDir).map((r) => r.id)).toEqual(["w-001"]);
    } finally {
      stubbedQueueDir.current = "";
    }
  });

  it("an unparsable ticket is skipped", () => {
    const logDir = mkdtempSync(join(tmpdir(), "cap-junk-"));
    dirs.push(logDir);
    const q = join(logDir, "queue", "p");
    mkdirSync(q, { recursive: true });
    writeFileSync(join(q, "w-001"), `${process.pid}`);
    writeFileSync(join(q, "w-002"), "not a pid");
    expect(liveQueue(logDir, "p")).toEqual(["w-001"]);
  });
});
