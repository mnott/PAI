/**
 * gate.ts — run one command under the machine-wide build queue.
 *
 * `runBuild` enqueues a ticket, waits its turn (heartbeat lines), then runs
 * the command in its own process group at low CPU priority with the log teed
 * to <buildsDir>/<id>.log. The tree dies with the caller: signals kill the
 * group, a parent-death poll covers a vanished shell, and a detached watcher
 * covers a SIGKILLed gate. A command run from inside another gated build
 * (PAI_BUILD_TICKET set, e.g. a door called by `pai build run`) just runs.
 * A test-kind job (simulator/device runs) draws from its own pool of slots and
 * shuts down the simulators it booted when it ends.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { basename } from "node:path";
import {
  buildLogPath,
  enqueue,
  getTicket,
  listBuilds,
  patchTicket,
  removeTicket,
  tryStart,
  type BuildKind,
  type BuildTicket,
  type QueueDeps,
} from "./queue.js";
import { bootedSimulators, shutdownAdded, type Simctl } from "./simulators.js";

export interface RunBuildOptions {
  dir: string;
  command: string[];
  full?: boolean;
  label?: string;
  /** Pool the job draws from (default "build"). */
  kind?: BuildKind;
  /** Slots of that pool. */
  slots: number;
  /** simctl runner for the test-kind simulator cleanup (default: real `xcrun simctl`). */
  simctl?: Simctl;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Poll interval while waiting for a slot. */
  pollMs?: number;
  /** Heartbeat line interval while waiting. */
  heartbeatMs?: number;
  out?: (line: string) => void;
  /** Start the detached watcher for a SIGKILLed gate (the CLI passes one; tests may leave it out). */
  spawnWatcher?: (dir: string, id: string) => void;
  /** Install signal handlers (CLI yes; tests drive abort themselves). */
  handleSignals?: boolean;
  deps?: Partial<QueueDeps>;
  /** Wrapper that lowers the child's CPU priority; default: taskpolicy -b / nice -n 10. */
  lowPriority?: (cmd: string[]) => string[];
  /** The caller is gone when this returns true (default: reparented away from the original parent). */
  callerGone?: () => boolean;
}

export function sessionName(env: NodeJS.ProcessEnv, cwd: string): string {
  if (env.PAI_WORKER_ID) return `worker ${env.PAI_WORKER_ID}`;
  return env.PAI_SESSION_NAME || basename(cwd) || "session";
}

export function lowPriorityWrap(cmd: string[], platform = process.platform): string[] {
  if (platform === "darwin" && existsSync("/usr/sbin/taskpolicy")) return ["/usr/sbin/taskpolicy", "-b", ...cmd];
  return ["nice", "-n", "10", ...cmd];
}

const fmtWait = (ms: number): string => (ms < 90_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`);

/** Run `command` through the queue; resolves to the exit code. */
export async function runBuild(o: RunBuildOptions): Promise<number> {
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const out = o.out ?? ((l: string) => process.stderr.write(l + "\n"));
  const mode = o.full ? "full" : "delta";
  const childEnv = { ...env, PAI_BUILD_MODE: mode };
  const wrap = o.lowPriority ?? lowPriorityWrap;

  // A door that calls `pai build lock` from inside `pai build run` already holds the slot.
  if (env.PAI_BUILD_TICKET) return exec(wrap(o.command), { ...childEnv }, cwd, null, o, undefined);

  const kind: BuildKind = o.kind ?? "build";
  const label = o.label || o.command.slice(0, 2).join(" ");
  const ticket = await enqueue(
    o.dir,
    { pid: process.pid, label, session: sessionName(env, cwd), worker: env.PAI_WORKER_ID, cmd: o.command.join(" "), mode, kind },
    o.deps
  );
  o.spawnWatcher?.(o.dir, ticket.id);

  let aborted: NodeJS.Signals | null = null;
  let child: ChildProcess | null = null;
  const killChild = (): void => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* gone */
      }
      const pid = child.pid;
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }, 3000).unref();
    }
  };
  const onSig = (sig: NodeJS.Signals): void => {
    aborted = sig;
    killChild();
  };
  const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  if (o.handleSignals) for (const s of sigs) process.on(s, onSig);
  const ppid0 = process.ppid;
  const gone = o.callerGone ?? (() => process.ppid !== ppid0);
  const watch = setInterval(() => {
    if (!aborted && gone()) onSig("SIGHUP");
  }, 1000);

  try {
    const started = Date.now();
    let lastBeat = 0;
    const poll = o.pollMs ?? 500;
    const beat = o.heartbeatMs ?? 30_000;
    for (;;) {
      if (aborted) return 128 + (aborted === "SIGINT" ? 2 : aborted === "SIGHUP" ? 1 : 15);
      if (await tryStart(o.dir, ticket.id, o.slots, o.deps)) break;
      if (Date.now() - lastBeat >= beat) {
        lastBeat = Date.now();
        out(await queuedLine(o.dir, ticket, started, o.deps));
      }
      await new Promise((r) => setTimeout(r, poll));
    }
    if (kind === "test") await patchTicket(o.dir, ticket.id, { bootedBefore: bootedSimulators(o.simctl) });
    out(`build started: ${label} (${mode}) — log ${buildLogPath(o.dir, ticket.id)}`);
    const code = await exec(wrap(o.command), { ...childEnv, PAI_BUILD_TICKET: ticket.id }, cwd, ticket, o, (c) => {
      child = c;
      if (aborted) killChild();
    });
    return aborted ? 128 + (aborted === "SIGINT" ? 2 : aborted === "SIGHUP" ? 1 : 15) : code;
  } finally {
    clearInterval(watch);
    if (kind === "test") {
      const t = await getTicket(o.dir, ticket.id);
      if (t?.bootedBefore) shutdownAdded(t.bootedBefore, o.simctl);
    }
    if (o.handleSignals) for (const s of sigs) process.off(s, onSig);
    await removeTicket(o.dir, ticket.id);
  }
}

async function queuedLine(dir: string, me: BuildTicket, since: number, deps?: Partial<QueueDeps>): Promise<string> {
  const all = await listBuilds(dir, deps);
  const idx = all.findIndex((t) => t.id === me.id);
  const waiting = all.filter((t) => t.state === "waiting");
  const pos = waiting.findIndex((t) => t.id === me.id) + 1;
  const behind = idx > 0 ? all[idx - 1] : null;
  return `build queued: position ${pos || "?"}${behind ? `, behind ${behind.label} from ${behind.session}` : ""}, waiting ${fmtWait(Date.now() - since)}`;
}

function exec(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  ticket: BuildTicket | null,
  o: RunBuildOptions,
  onChild?: (c: ChildProcess) => void
): Promise<number> {
  return new Promise((resolve) => {
    const log = ticket ? createWriteStream(buildLogPath(o.dir, ticket.id), { flags: "a" }) : null;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["inherit", "pipe", "pipe"] });
    onChild?.(child);
    if (ticket && child.pid) void patchTicket(o.dir, ticket.id, { pgid: child.pid });
    child.stdout?.on("data", (b: Buffer) => {
      process.stdout.write(b);
      log?.write(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      process.stderr.write(b);
      log?.write(b);
    });
    child.on("error", (e) => {
      process.stderr.write(`pai build: cannot run ${argv[0]}: ${e.message}\n`);
      log?.end();
      resolve(127);
    });
    child.on("close", (code, sig) => {
      log?.end();
      resolve(code ?? (sig ? 128 + (sig === "SIGKILL" ? 9 : 15) : 1));
    });
  });
}

/** Detached-watcher body: kill the build tree, drop the ticket and shut down the simulators a test job booted once the gate process is gone. */
export async function watchTicket(dir: string, id: string, deps: Partial<QueueDeps> = {}, intervalMs = 1000, simctl?: Simctl): Promise<void> {
  const isAlive = deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (;;) {
    const t = await getTicket(dir, id);
    if (!t) return;
    if (!isAlive(t.pid)) {
      await listBuilds(dir, deps); // prune kills the group and removes the ticket
      if (t.kind === "test" && t.bootedBefore) shutdownAdded(t.bootedBefore, simctl);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
