/**
 * pane-state.test.ts — the worker pane shows the SAME state word as the cockpit queue:
 * both go through buildQueueTable → stateBadge (queue-table.ts) and the pane re-reads it
 * every refresh tick (status file + queue tickets), so a job admitted or resumed updates
 * within one tick. No separate state derivation in the viewer or the pane bar.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQueueTable, cloudWhy, stateBadge, type TableInput } from "./queue-table.js";
import { paneStateWord } from "./pane-bar.js";
import { paneQueueStatusRow } from "./render.js";
import { saveStatus, type WorkerStatus } from "./status.js";
import type { WorkersConfig } from "./config.js";

const QNOW = Date.parse("2026-11-18T12:00:00");
const qst = (id: string, o: Partial<WorkerStatus> = {}): WorkerStatus =>
  ({ id, label: `task ${id}`, provider: "lm", model: "qwen", state: "running", started: "2026-11-18 11:50:00", updated: "2026-11-18 11:59:55", cwd: "/x", pid: 1, ...o }) as WorkerStatus;
const qin = (statuses: WorkerStatus[], queue: TableInput["queue"] = [], more: Partial<TableInput> = {}): TableInput => ({
  statuses,
  queue,
  panes: [],
  now: QNOW,
  isLocal: () => true,
  sessionOf: () => "other",
  ...more,
});

describe("the pane's state word is the cockpit's word", () => {
  // the words of every row in ONE table, as the cockpit draws them (stateBadge)
  const words = (input: TableInput): Record<string, string> =>
    Object.fromEntries(buildQueueTable(input).map((r) => [r.id, stateBadge(r)]));

  it("running, waiting #n, paused, frozen — the same word in both", () => {
    const w1 = qst("w1", { state: "queued" });
    const w2 = qst("w2", { state: "queued" });
    const by = words(qin([qst("a"), w1, w2, qst("p", { paused: true }), qst("f")], [
      { id: "w1", provider: "lm", position: 1, queued: 2, status: w1 },
      { id: "w2", provider: "lm", position: 2, queued: 2, status: w2 },
    ], { frozen: (id) => id === "f" }));
    expect(by).toMatchObject({ a: "running", w1: "waiting #1", w2: "waiting #2", p: "paused", f: "frozen" });
  });

  it("paneQueueStatusRow leads the row with the cockpit's word, and no word adds nothing", () => {
    const s = qst("a");
    expect(paneQueueStatusRow(s, "waiting #2", new Date(QNOW))).toMatch(/^waiting #2 · /);
    expect(paneQueueStatusRow(s, null, new Date(QNOW))).not.toMatch(/^(running|waiting|paused|frozen) ·/);
  });
});

describe("paneStateWord over the real files: same word, updates next tick", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "panestate-"));
    process.env.PAI_CONFIG_FILE = join(dir, "config.yaml");
    writeFileSync(process.env.PAI_CONFIG_FILE, "workers:\n  providers:\n    lm:\n      baseUrl: http://127.0.0.1:1/v1\n      models:\n        default: qwen\n", "utf8");
    mkdirSync(join(dir, "queue", "lm"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cfg = (): WorkersConfig => ({ providers: { lm: { baseUrl: "http://127.0.0.1:1/v1", models: { default: "qwen" } } } }) as unknown as WorkersConfig;
  // owns injected: the fixtures carry this test process's pid, not a real run's
  const word = (id: string) => paneStateWord(dir, id, Date.now(), cfg(), () => true);
  const live = { pid: process.pid, runPid: process.pid };

  it("a queued ticket reads 'waiting #n', a running status 'running', a paused one 'paused'", () => {
    saveStatus(dir, qst("w1", { state: "queued" }));
    writeFileSync(join(dir, "queue", "lm", "w1"), `${process.pid} @${Date.now()}`, "utf8");
    expect(word("w1")).toBe("waiting #1");
    saveStatus(dir, qst("r1", live));
    expect(word("r1")).toBe("running");
    saveStatus(dir, qst("p1", { ...live, paused: true }));
    expect(word("p1")).toBe("paused");
  });

  it("a fixture that changes from queued to running updates on the next tick", () => {
    saveStatus(dir, qst("j", { state: "queued" }));
    writeFileSync(join(dir, "queue", "lm", "j"), `${process.pid} @${Date.now()}`, "utf8");
    expect(word("j")).toBe("waiting #1"); // tick 1: still in the queue
    rmSync(join(dir, "queue", "lm", "j")); // admitted: ticket gone, status running
    saveStatus(dir, qst("j", { ...live, state: "running" }));
    expect(word("j")).toBe("running"); // tick 2: the pane shows the new word
  });

  it("no row for the id reads null (the plain row, no word)", () => {
    expect(word("nope")).toBeNull();
  });
});

describe("queue level and why a job runs on the cloud", () => {
  it("L1 for orchestrate/plan, L2 otherwise; a child follows its L1; cloud reason from the recorded fields", () => {
    const rows = buildQueueTable(
      qin(
        [
          qst("a-1", { className: "implement", parent: "o-1", started: "2026-11-18 11:51:00", provider: "anthropic", model: "claude-sonnet-5-5", route: { policy: "auto", reason: "rerouted (escalation: no edit or commit for 10m)", local: false } }),
          qst("o-1", { className: "orchestrate", started: "2026-11-18 11:52:00", provider: "anthropic", model: "claude-opus-5-5", routeWhy: "class: orchestrate" }),
          qst("b-1", { className: "implement", parent: "o-1", started: "2026-11-18 11:53:00", provider: "anthropic", model: "claude-sonnet-5-5", route: { policy: "auto", reason: "rerouted (cli)", local: false } }),
          qst("c-1", { started: "2026-11-18 11:54:00" }),
        ],
        [],
        { isLocal: (p) => p === "lm" },
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(["o-1", "a-1", "b-1", "c-1"]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["o-1"]!.level).toBe(1);
    expect(by["a-1"]!.level).toBe(2);
    expect(by["o-1"]!.cloudWhy).toBe("class orchestrate runs on the cloud");
    expect(by["a-1"]!.cloudWhy).toBe("moved: no edit or commit for 10 min on the local model");
    expect(by["b-1"]!.cloudWhy).toBe("moved by operator");
    expect(by["c-1"]!.cloudWhy).toBeUndefined();
    expect(cloudWhy({ routeWhy: "class: x" } as WorkerStatus, false)).toBe("class x runs on the cloud");
  });
});
