/**
 * pool-host.test.ts — the pool host driven end to end against a fake slot
 * process: two tasks through one warm slot (boundary per turn, carry metric
 * per task), proof check against the task's own bash runs, busy refusal,
 * idle reaping, and the HTTP surface.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createPoolHost, type PoolHost } from "./pool-host.js";
import {
  poolHostAlive,
  poolMetricsPath,
  postTaskToPool,
  readPoolMetrics,
  type PoolTaskRequest,
  type SlotProcess,
} from "./pool.js";
import { defaultWorkersConfig, type WorkerProvider, type WorkersConfig } from "./config.js";
import { eventsPath, ledgerPath, statusPath } from "./paths.js";
import { parseLedger } from "./ledger.js";
import { ROUTER_PORT } from "../router/router.js";
import { git } from "./worktree.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const provider = (over: Partial<WorkerProvider> = {}): WorkerProvider => ({
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://example.invalid",
  keyFile: null,
  models: { default: "m1" },
  env: {},
  ...over,
});

const testConfig = (over: { maxSlots?: number; idleSecs?: number } = {}): WorkersConfig => ({
  ...defaultWorkersConfig(),
  caveman: false,
  pool: { enabled: true, maxSlots: over.maxSlots ?? 1, idleSecs: over.idleSecs ?? 0, port: 0, native: true },
  providers: {
    fakeprov: provider(),
    anthropic: provider({ native: true }),
    loopprov: provider({ baseUrl: "http://127.0.0.1:8080/v1" }),
  },
});

const line = (parts: string[]): string => parts.join("\n") + "\n";
// fixtures pass the real `aibroker agentish check` validator (c= needs a
// path summary, r≠+ needs y=, r=+ needs G=+)
const R_PLAIN_1 = line(["R", "i=pool-one", "r=-", "t=Smoke+", "c=src/x changed it", "y=not run, smoke only", "z=nothing to verify"]);
const R_PLAIN_2 = line(["R", "i=pool-two", "r=-", "t=Smoke+", "c=src/x changed it", "y=not run, smoke again", "z=nothing to verify"]);
const R_PROOF_CLAIM = line(["R", "i=proofless", "r=+", "G=+", "p=echo proof", "t=A+", "c=src/x changed it", "z=done"]);

const usage1 = { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 8000 };
const usage2 = { input_tokens: 500, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000 };
const INIT = { type: "system", subtype: "init", session_id: "sess-fake-1", model: "m1" };
const assistantUsage = (u: typeof usage1): Record<string, unknown> => ({
  type: "assistant",
  message: { usage: u, content: [{ type: "text", text: "on it" }] },
});
const bashToolUse = {
  type: "assistant",
  message: {
    usage: usage1,
    content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "echo proof" } }],
  },
};
const toolResultOk = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "out\nExit code 0" }] },
};
const resultEvt = (result: string): Record<string, unknown> => ({ type: "result", is_error: false, result });

// ---------------------------------------------------------------------------
// Fake slot process: emits scripted stream-json lines per fed turn
// ---------------------------------------------------------------------------

class FakeSlot implements SlotProcess {
  readonly pid = process.pid; // pickSlot probes liveness with kill(pid, 0)
  readonly fedTexts: string[] = [];
  killed = false;
  private lineCb: ((l: string) => void) | null = null;
  constructor(
    private groups: Array<Array<Record<string, unknown>>>,
    private fallback: () => Array<Record<string, unknown>>
  ) {
    // a real claude announces its session unprompted, right after startup
    queueMicrotask(() => this.emit(INIT));
  }
  private emit(obj: Record<string, unknown>): void {
    this.lineCb?.(JSON.stringify(obj));
  }
  write(text: string): boolean {
    try {
      this.fedTexts.push(String(JSON.parse(text).message?.content ?? ""));
    } catch {
      this.fedTexts.push(text);
    }
    const group = this.groups.shift() ?? this.fallback();
    for (const obj of group) this.emit(obj);
    return true;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(_cb: (code: number | null) => void): void {
    /* the fake never exits on its own */
  }
  emitNow(obj: Record<string, unknown>): void {
    this.emit(obj);
  }
}

interface Harness {
  host: PoolHost;
  slots: FakeSlot[];
  argvs: string[][];
  envs: NodeJS.ProcessEnv[];
  cwds: string[];
  script: (groups: Array<Array<Record<string, unknown>>>) => void;
}

function makeHost(
  cfgOver: { maxSlots?: number; idleSecs?: number } = {},
  now?: () => Date,
  opts: { routerEnabled?: boolean; prodBuilders?: boolean; probeRouter?: () => Promise<boolean> } = {}
): Harness {
  const logDir = mkdtempSync(join(tmpdir(), "pai-pool-host-"));
  const slots: FakeSlot[] = [];
  const argvs: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const cwds: string[] = [];
  const nextGroups: Array<Array<Record<string, unknown>>> = [];
  const fallback = (): Array<Record<string, unknown>> => [assistantUsage(usage1), resultEvt(R_PLAIN_1)];
  const spawner = (argv: string[], cwd: string, env: NodeJS.ProcessEnv): SlotProcess => {
    argvs.push(argv);
    envs.push(env);
    cwds.push(cwd);
    const slot = new FakeSlot(nextGroups.splice(0), fallback);
    slots.push(slot);
    return slot;
  };
  const host = createPoolHost({
    config: testConfig(cfgOver),
    logDir,
    spawner: (argv, cwd, env) => spawner(argv, cwd, env),
    // the production env/argv builders, for the route tests below
    ...(opts.prodBuilders ? {} : { envFor: () => ({}) }),
    ...(opts.prodBuilders ? {} : { cmdHead: () => ["fake-claude"] }),
    ...(opts.routerEnabled !== undefined ? { routerEnabled: opts.routerEnabled } : {}),
    ...(opts.probeRouter ? { probeRouter: opts.probeRouter } : {}),
    ...(now ? { now } : {}),
    noReaper: true,
  });
  return {
    host,
    slots,
    argvs,
    envs,
    cwds,
    script: (groups) => nextGroups.push(...groups),
  };
}

const task = (over: Partial<PoolTaskRequest> = {}): PoolTaskRequest => ({
  id: "w1",
  label: "first",
  prompt: "TASK ONE SPEC",
  provider: "fakeprov",
  model: "m1",
  cwd: tmpdir(),
  reportFormat: "ag2",
  outputFormat: "text",
  maxMinutes: null,
  trailer: "\nREPORT-FORMAT-END",
  ...over,
});

// every host created by a test gets closed here, so vitest can exit
const liveHosts: PoolHost[] = [];
afterEach(async () => {
  while (liveHosts.length) {
    const h = liveHosts.pop()!;
    h.server.closeAllConnections?.();
    await h.shutdown();
  }
});

describe("pooled task lifecycle", () => {
  it("two tasks run through ONE warm slot, each with its own boundary, status and carry metric", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    // distinct first-request usage per task, so the carry rows differ
    h.script([
      [assistantUsage(usage1), resultEvt(R_PLAIN_1)],
      [assistantUsage(usage2), resultEvt(R_PLAIN_2)],
    ]);

    const r1 = await h.host.runTask(task());
    expect(r1.pooled).toBe(true);
    expect(r1.rc).toBe(0);
    expect(h.slots.length).toBe(1);
    expect(h.argvs[0]?.some((a) => a === "--input-format")).toBe(true);

    const r2 = await h.host.runTask(task({ id: "w2", label: "second", prompt: "TASK TWO SPEC" }));
    expect(r2.pooled).toBe(true);
    expect(h.slots.length).toBe(1); // no second spawn: the slot stayed warm

    // the turns: task 1 and 2 texts, second opens with ITS boundary only
    expect(h.slots[0]!.fedTexts.length).toBe(2);
    const t1 = h.slots[0]!.fedTexts[0]!;
    const t2 = h.slots[0]!.fedTexts[1]!;
    expect(t1).toContain("NEW TASK 1");
    expect(t1).toContain("TASK ONE SPEC");
    expect(t1.trimEnd().endsWith("REPORT-FORMAT-END")).toBe(true);
    expect(t2).toContain("NEW TASK 2");
    expect(t2).toContain("TASK TWO SPEC");
    expect(t2).not.toContain("TASK ONE SPEC");
    expect(t2).not.toContain("NEW TASK 1");
    // the slot argv pins the identity: fixed model, no MCP, stream-json IO
    const argv = h.argvs[0]!.join(" ");
    expect(argv).toContain("--model m1");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--output-format stream-json");

    // slot record: two tasks served, session id from the init event
    const st = h.host.state();
    expect(st.tasksServed).toBe(2);
    expect(st.slots.length).toBe(1);
    expect(st.slots[0]!.tasks).toBe(2);
    expect(st.slots[0]!.claudeSession).toBe("sess-fake-1");
    expect(st.slots[0]!.busyWith).toBeNull();

    // carry metrics: one row per task, from each turn's FIRST assistant usage
    const rows = readPoolMetrics(poolMetricsPath(h.host.logDir));
    expect(rows.map((r) => r.task)).toEqual([1, 2]);
    expect(rows.map((r) => r.id)).toEqual(["w1", "w2"]);
    expect(rows[0]!.cache_read_input_tokens).toBe(8000);
    expect(rows[1]!.cache_read_input_tokens).toBe(9000);
    expect(st.tokensCarried).toBe(17000);

    // per-task worker identity on disk
    for (const [wid, no] of [["w1", 1], ["w2", 2]] as const) {
      const status = JSON.parse(readFileSync(statusPath(h.host.logDir, wid), "utf8")) as {
        state: string;
        rc: number;
        pool?: { task: number; slotSession: string | null };
      };
      expect(status.state).toBe("done");
      expect(status.rc).toBe(0);
      expect(status.pool?.task).toBe(no);
      expect(status.pool?.slotSession).toBe("sess-fake-1");
      const mirror = readFileSync(eventsPath(h.host.logDir, wid), "utf8").split("\n").filter(Boolean);
      expect(JSON.parse(mirror[0]!).type).toBe("pooled-task");
      expect(mirror.some((l) => l.includes('"type":"result"'))).toBe(true);
    }

    // ledger: the pooled task is a first-class worker start/end
    const lines = parseLedger(readFileSync(ledgerPath(h.host.logDir), "utf8"));
    const start = lines.find((l) => l.event === "WORKER-START" && l.fields.id === "w1");
    expect(start?.fields.mode).toBe("pooled");
    expect(start?.fields.poolTask).toBe("1");
    const end = lines.find((l) => l.event === "WORKER-END" && l.fields.id === "w2");
    expect(end?.fields.rc).toBe("0");
    expect(end?.fields.poolTask).toBe("2");
    expect(lines.some((l) => l.event === "WORKER-POOL-SLOT")).toBe(true);
  });

  it("slots are keyed by cwd: a second cwd gets its own slot in that directory, the first stays warm", async () => {
    const h = makeHost({ maxSlots: 2 });
    liveHosts.push(h.host);
    const dirA = mkdtempSync(join(tmpdir(), "pai-pool-cwd-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "pai-pool-cwd-b-"));
    h.script([
      [assistantUsage(usage1), resultEvt(R_PLAIN_1)],
      [assistantUsage(usage2), resultEvt(R_PLAIN_2)],
      [assistantUsage(usage2), resultEvt(R_PLAIN_2)],
    ]);
    await h.host.runTask(task({ id: "a1", cwd: dirA }));
    await h.host.runTask(task({ id: "b1", cwd: dirB }));
    await h.host.runTask(task({ id: "a2", cwd: dirA }));
    expect(h.slots.length).toBe(2);
    const st = h.host.state();
    expect(st.slots.map((s) => s.cwd).sort()).toEqual([dirA, dirB].sort());
    expect(st.slots.find((s) => s.cwd === dirA)!.tasks).toBe(2);
    expect(h.slots[0]!.fedTexts[0]).toContain(`Your working directory is ${dirA}`);
  });

  it("a claimed proof without a bash run in THIS task's turn is rewritten", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    h.script([[assistantUsage(usage1), resultEvt(R_PROOF_CLAIM)]]);
    const r = await h.host.runTask(task({ id: "wp1", prompt: "claim it" }));
    expect(r.rc).toBe(0);
    expect(r.resultEvent?.result).toContain("claimed proof not run or failed: echo proof");
    expect(r.resultEvent?.result).toContain("r=~");
    const status = JSON.parse(readFileSync(statusPath(h.host.logDir, "wp1"), "utf8")) as {
      reportValid?: boolean;
      last?: string;
    };
    expect(status.reportValid).toBe(false);
    expect(status.last).toContain("claimed proof not run");
    const lines = parseLedger(readFileSync(ledgerPath(h.host.logDir), "utf8"));
    expect(lines.some((l) => l.event === "REPORT-PROOF-UNVERIFIED" && l.fields.id === "wp1")).toBe(true);
  });

  it("a bash run within the task's turn satisfies the proof claim", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    h.script([[assistantUsage(usage1), bashToolUse, toolResultOk, resultEvt(R_PROOF_CLAIM)]]);
    const r = await h.host.runTask(task({ id: "wp2", prompt: "run then claim" }));
    expect(r.rc).toBe(0);
    expect(r.resultEvent?.result).toBe(R_PROOF_CLAIM); // untouched
    expect(r.resultEvent?.result).not.toContain("claimed proof");
  });

  it("a busy slot refuses a second concurrent task instead of interleaving", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    h.script([[assistantUsage(usage1)]]); // no result yet: task A holds the slot
    const pendingA = h.host.runTask(task({ id: "wA", prompt: "TASK A SPEC" }));
    await new Promise((r) => setTimeout(r, 10));
    const busy = await h.host.runTask(task({ id: "wB", prompt: "TASK B SPEC" }));
    expect(busy).toEqual({ pooled: false, reason: "busy" });
    h.slots[0]!.emitNow(resultEvt(R_PLAIN_1));
    const a = await pendingA;
    expect(a.pooled).toBe(true);
    expect(a.status?.pool?.task).toBe(1);
  });

  it("an idle slot is reaped after idleSecs and its kill lands", async () => {
    let nowMs = Date.parse("2026-10-16T22:00:00Z");
    const h = makeHost({ idleSecs: 60 }, () => new Date(nowMs));
    liveHosts.push(h.host);
    await h.host.runTask(task({ id: "w-idle", prompt: "then idle" }));
    expect(h.host.state().slots.length).toBe(1);
    expect(h.host.reapSlots()).toBe(0); // fresh: 0s idle < 60s
    nowMs += 61_000;
    expect(h.host.reapSlots()).toBe(1);
    expect(h.host.state().slots.length).toBe(0);
    expect(h.slots[0]!.killed).toBe(true);
    // (ledger values keep their spaces, so match on the raw line)
    const raw = readFileSync(ledgerPath(h.host.logDir), "utf8");
    expect(raw).toContain("WORKER-POOL-SLOT-END");
    expect(raw).toContain("idle timeout");
  });

  it("the host serves native anthropic (workers.pool.native on) and refuses unknown providers", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    const native = await h.host.runTask(task({ id: "wn", provider: "anthropic" }));
    expect(native.pooled).toBe(true);
    const unknown = await h.host.runTask(task({ id: "wu", provider: "nope" }));
    expect(unknown).toEqual({ pooled: false, reason: "engine" });
    expect(h.slots.length).toBe(1);
  });

  it("a worktree task on a loopback provider ends its slot process: fresh conversation, same slot dir", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    const repo = mkdtempSync(join(tmpdir(), "pai-pool-wt-repo-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    git(repo, ["config", "user.name", "worker test"]);
    writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    h.script([
      [assistantUsage(usage1), resultEvt(R_PLAIN_1)],
      [assistantUsage(usage2), resultEvt(R_PLAIN_2)],
    ]);
    const r1 = await h.host.runTask(task({ id: "wt1", provider: "loopprov", cwd: repo, worktree: true }));
    const r2 = await h.host.runTask(task({ id: "wt2", provider: "loopprov", cwd: repo, worktree: true, prompt: "TASK TWO SPEC" }));
    expect(r1.pooled).toBe(true);
    expect(r2.pooled).toBe(true);
    expect(h.slots.length).toBe(2); // one process per task: no shared conversation
    expect(h.cwds[0]).toBe(h.cwds[1]); // the same slot worktree dir
    expect(h.cwds[0]).not.toBe(repo);
    expect(h.slots[0]!.fedTexts.length).toBe(1);
    expect(h.slots[1]!.fedTexts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Slot route: pooled traffic must reach the router's usage log
// ---------------------------------------------------------------------------

describe("pool slot route", () => {
  const pinned = (argv: string[]): { env: Record<string, string> } => JSON.parse(argv[2]!);

  it("SlotEnvUsesRouterWhenEnabled — slot env and --settings pin carry the router, never the provider", async () => {
    const h = makeHost({}, undefined, { routerEnabled: true, prodBuilders: true });
    liveHosts.push(h.host);
    await h.host.runTask(task());
    expect(h.envs[0]!.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${ROUTER_PORT}`);
    expect(pinned(h.argvs[0]!).env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${ROUTER_PORT}`);
    // no provider-direct route anywhere in the slot launch: the settings pin
    // outranks the process env, so a direct URL there would win
    expect(h.argvs[0]!.join(" ")).not.toContain("example.invalid");
  });

  it("SlotEnvDirectWhenRouterOff — the provider route is pinned as before", async () => {
    const h = makeHost({}, undefined, { routerEnabled: false, prodBuilders: true });
    liveHosts.push(h.host);
    await h.host.runTask(task());
    expect(h.envs[0]!.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
    const pin = pinned(h.argvs[0]!);
    expect(pin.env.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
    expect(JSON.stringify(pin)).not.toContain(String(ROUTER_PORT));
  });

  it("LoopbackSlotUsesRouterWhenUp — a loopback provider's slot goes through the router even with the global flag off", async () => {
    const h = makeHost({}, undefined, { routerEnabled: false, prodBuilders: true, probeRouter: async () => true });
    liveHosts.push(h.host);
    await h.host.runTask(task({ provider: "loopprov" }));
    expect(h.envs[0]!.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${ROUTER_PORT}`);
    expect(h.envs[0]!.ANTHROPIC_CUSTOM_HEADERS).toBe("x-pai-provider: loopprov");
  });

  it("LoopbackSlotDirectWhenRouterDown — falls back to the provider URL", async () => {
    const h = makeHost({}, undefined, { routerEnabled: false, prodBuilders: true, probeRouter: async () => false });
    liveHosts.push(h.host);
    await h.host.runTask(task({ provider: "loopprov" }));
    expect(h.envs[0]!.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080/v1");
  });

  it("PooledUsageReachableInRouterLog — the launch keys router rows to the pool's model and session", async () => {
    const h = makeHost({}, undefined, { routerEnabled: true, prodBuilders: true });
    liveHosts.push(h.host);
    h.script([[assistantUsage(usage1), resultEvt(R_PLAIN_1)]]);
    const r = await h.host.runTask(task({ model: "glm-5.3-flash" }));
    expect(r.pooled).toBe(true);
    // route: only the router — its usage log is where the rows must land
    expect(h.envs[0]!.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${ROUTER_PORT}`);
    // model: on the argv, so the router resolves it to the provider and each
    // usage row's model joins the pool metric's model column
    const argv = h.argvs[0]!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("glm-5.3-flash");
    // auth: the placeholder token is pinned so claude sends an auth header at
    // all; the router drops it and injects the provider key
    expect(pinned(argv).env.ANTHROPIC_AUTH_TOKEN).toBe("local");
    // session: the slot's init event ids the session the router rows will carry
    expect(h.host.state().slots[0]!.claudeSession).toBe("sess-fake-1");
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function httpJson<T>(port: number, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

describe("pool host HTTP", () => {
  it("serves /healthz, /task, /status and /shutdown on the loopback port", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    await new Promise<void>((resolve) => h.host.server.listen(0, "127.0.0.1", resolve));
    const port = (h.host.server.address() as { port: number }).port;

    expect(await poolHostAlive(port)).toBe(true);
    const resp = await postTaskToPool(port, task({ id: "w-http", prompt: "over http" }), 10_000);
    expect(resp?.pooled).toBe(true);
    expect(resp?.rc).toBe(0);
    expect(resp?.status?.pool?.task).toBe(1);
    expect(resp?.report?.result).toBe("-"); // the AG2 outcome char, parsed

    const status = await httpJson<{ tasksServed: number; carry: { tasks: number } }>(port, "GET", "/status");
    expect(status.tasksServed).toBe(1);
    expect(status.carry.tasks).toBe(1);

    await httpJson<{ ok: boolean }>(port, "POST", "/shutdown", {});
    expect(h.slots[0]!.killed).toBe(true);
    // (a keep-alive socket from the earlier POST would still serve /healthz,
    // so assert on the listener itself, not on one more request)
    expect(h.host.server.listening).toBe(false);
  });

  it("a task over HTTP still writes its status file next to fresh-spawn runs", async () => {
    const h = makeHost();
    liveHosts.push(h.host);
    await new Promise<void>((resolve) => h.host.server.listen(0, "127.0.0.1", resolve));
    const port = (h.host.server.address() as { port: number }).port;
    await postTaskToPool(port, task({ id: "w-file" }), 10_000);
    expect(existsSync(statusPath(h.host.logDir, "w-file"))).toBe(true);
  });
});
