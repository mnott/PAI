import { describe, expect, it } from "vitest";
import { freshLoadWatchState, loadWatchConfig, loadWatchTick, selectSuspects, stepLoadWatch, type LoadWatchDeps, type PsRow } from "./load-watch.js";
import type { WorkerStatus } from "../workers/status.js";

const cfg = loadWatchConfig(undefined);
const MIN = 60_000;

describe("threshold and duration", () => {
  it("starts only after N minutes over, resets when load dips, thaws after 5 under", () => {
    let r = stepLoadWatch(freshLoadWatchState(), 50, 30, cfg, 0);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 50, 30, cfg, 9 * MIN);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 10, 30, cfg, 9.5 * MIN);
    r = stepLoadWatch(r.state, 50, 30, cfg, 10 * MIN);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 50, 30, cfg, 21 * MIN);
    expect(r.step).toBe("start");
    r = stepLoadWatch(r.state, 5, 30, cfg, 22 * MIN);
    expect(r.step).toBe("none");
    r = stepLoadWatch(r.state, 5, 30, cfg, 27 * MIN);
    expect(r.step).toBe("thaw");
  });
});

const st = (id: string, state: string): WorkerStatus => ({ id, state } as unknown as WorkerStatus);
const row = (pid: number, ppid: number, cpu: number, command: string): PsRow => ({ pid, ppid, cpu, etime: "01:00", command });

describe("suspect selection", () => {
  it("ties an orphan in a scratch dir to its worker; unrelated busy process is not a suspect", () => {
    const rows = [
      row(11, 1, 99, "/bin/bash /tmp/pai-scratch/w-ended/loop.sh"),
      row(12, 1, 99, "/bin/bash /tmp/pai-scratch/w-live/loop.sh"),
      row(13, 1, 99, "/usr/bin/some-compiler --big"),
      row(14, 1, 80, "/bin/zsh -c while true; do :; done"),
    ];
    const s = selectSuspects(rows, [st("w-ended", "done"), st("w-live", "running")], "/logs/workers", 1);
    expect(s.map((x) => [x.pid, x.workerEnded])).toEqual([[11, true], [12, false], [14, false]]);
  });
});

describe("episode", () => {
  it("kills only the ended worker's orphan, reports the rest, alerts once per episode", async () => {
    const rows = [row(11, 1, 99, "/bin/bash /tmp/pai-scratch/w-ended/loop.sh"), row(13, 1, 99, "/usr/bin/other"), row(14, 1, 90, "/bin/zsh -c x")];
    const log = { kills: [] as number[], alerts: [] as string[], ledger: [] as string[], freezes: 0 };
    let now = 0;
    const d: LoadWatchDeps = {
      load5: () => 100,
      cores: () => 10,
      ps: async () => rows,
      statuses: () => [st("w-ended", "failed")],
      freeze: async () => (log.freezes++, "frozen"),
      thaw: async () => "thawed",
      kill: (p) => void log.kills.push(p),
      alert: async (t) => void log.alerts.push(t),
      ledger: (e, kv) => void log.ledger.push(`${e} pid=${kv.pid}`),
      write: () => undefined,
      now: () => now,
      self: 999,
      logDir: "/logs/workers",
    };
    let state = freshLoadWatchState();
    for (let i = 0; i < 25; i++) {
      state = await loadWatchTick(state, cfg, d);
      now += MIN;
    }
    expect(log.alerts).toHaveLength(1);
    expect(log.freezes).toBe(1);
    expect(log.kills).toEqual([11]);
    expect(log.ledger).toEqual(["LOADWATCH-KILL pid=11"]);
    expect(log.alerts[0]).toContain("14");
    expect(log.alerts[0]).toContain("load 100.0");
    expect(log.alerts[0]).toContain("killed 1".replace("k","K"));
    // load drops: one thaw line
    d.load5 = () => 1;
    for (let i = 0; i < 6; i++) {
      state = await loadWatchTick(state, cfg, d);
      now += MIN;
    }
    expect(log.alerts).toHaveLength(2);
    expect(log.alerts[1]).toContain("back under");
  });
});
