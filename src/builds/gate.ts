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

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, resolve } from "node:path";
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
import { jobPaths, reapJob, type ReapOptions } from "./reap.js";
import { bootedSimulators, shutdownAdded, type Simctl } from "./simulators.js";

export interface RunBuildOptions {
  dir: string;
  command: string[];
  full?: boolean;
  label?: string;
  /** Build key (explicit, PAI_BUILD_KEY, or derived from the command); same key = one at a time. */
  key?: string;
  /** Pool the job draws from (default "build"). */
  kind?: BuildKind;
  /** Slots of that pool. */
  slots: number;
  /** simctl runner for the test-kind simulator cleanup (default: real `xcrun simctl`). */
  simctl?: Simctl;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Called when the wait for a slot starts / ends (a worker's active-time accounting). */
  onWait?: (waiting: boolean) => void;
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
  /** Core count for PAI_BUILD_JOBS (default: perf cores on macOS, else os.cpus().length). */
  cores?: number;
  /** The caller is gone when this returns true (default: reparented away from the original parent). */
  callerGone?: () => boolean;
  /** Compiler reaping hooks (tests inject a process table and kill). */
  reap?: ReapOptions;
}

export function sessionName(env: NodeJS.ProcessEnv, cwd: string): string {
  if (env.PAI_WORKER_ID) return `worker ${env.PAI_WORKER_ID}`;
  return env.PAI_SESSION_NAME || basename(cwd) || "session";
}

export function lowPriorityWrap(cmd: string[], platform = process.platform): string[] {
  if (platform === "darwin" && existsSync("/usr/sbin/taskpolicy")) return ["/usr/sbin/taskpolicy", "-b", ...cmd];
  return ["nice", "-n", "10", ...cmd];
}

/** Physical cores: hw.perflevel0 + hw.perflevel1 on macOS, else os.cpus().length. */
export function coreCount(platform = process.platform): number {
  if (platform === "darwin") {
    try {
      const n = ["hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu"].reduce((sum, k) => sum + (Number(execFileSync("sysctl", ["-n", k], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || 0), 0);
      if (n > 0) return n;
    } catch {
      /* fall through */
    }
  }
  return cpus().length || 1;
}

/** Compiler parallelism one job may use: its share of the cores across all slots, at least 2. */
export const buildJobs = (cores: number, slots: number): number => Math.max(2, Math.floor(cores / Math.max(1, slots)));

/** Identity shared by every worktree of a repository: the main worktree root (git common dir's parent); cwd outside git. */
export function repoIdentity(cwd: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const abs = realpathSync(resolve(cwd, common));
    return basename(abs) === ".git" ? dirname(abs) : abs;
  } catch {
    return cwd;
  }
}

/**
 * Key for a raw command when none is given: "<repository>:<door>:<last argument>" for a script
 * (so `tools/build.sh test mac` and `tools/build.sh install mac` share one), "<repository>:xcodebuild:<scheme>"
 * for xcodebuild -scheme; anything else has no key. The repository is shared by all its worktrees.
 */
export function deriveKey(command: string[], cwd: string): string | undefined {
  const [c0, ...args] = command;
  if (!c0) return undefined;
  const proj = repoIdentity(cwd);
  if (basename(c0) === "xcodebuild") {
    const i = args.indexOf("-scheme");
    return i >= 0 && args[i + 1] ? `${proj}:xcodebuild:${args[i + 1]}` : undefined;
  }
  if (c0.includes("/") || c0.endsWith(".sh")) {
    const last = args.filter((a) => !a.startsWith("-")).pop();
    return `${proj}:${c0.replace(/^\.\//, "")}${last ? `:${last}` : ""}`;
  }
  return undefined;
}

/** Log files a door names in its output: "log: <path>" / "see <path>". */
export function declaredLogs(text: string): string[] {
  return [...text.matchAll(/(?:\blog:|\bsee)\s+(\/[^\s'")]+)/gi)].map((m) => m[1].replace(/[.,;:]+$/, ""));
}

const fmtWait = (ms: number): string => (ms < 90_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`);

/** Run `command` through the queue; resolves to the exit code. */
export async function runBuild(o: RunBuildOptions): Promise<number> {
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const out = o.out ?? ((l: string) => process.stderr.write(l + "\n"));
  const mode = o.full ? "full" : "delta";
  const key = o.key || env.PAI_BUILD_KEY || deriveKey(o.command, cwd);
  const childEnv = { ...env, PAI_BUILD_MODE: mode, PAI_BUILD_JOBS: env.PAI_BUILD_JOBS || String(buildJobs(o.cores ?? coreCount(), o.slots)) };
  const wrap = o.lowPriority ?? lowPriorityWrap;

  // A door that calls `pai build lock` from inside `pai build run` already holds the slot.
  if (env.PAI_BUILD_TICKET) return exec(wrap(o.command), { ...childEnv }, cwd, null, o, undefined);

  const kind: BuildKind = o.kind ?? "build";
  const label = o.label || o.command.slice(0, 2).join(" ");
  const ticket = await enqueue(
    o.dir,
    { pid: process.pid, label, session: sessionName(env, cwd), worker: env.PAI_WORKER_ID, key, cmd: o.command.join(" "), mode, kind },
    o.deps
  );
  o.spawnWatcher?.(o.dir, ticket.id);

  const paths = jobPaths(o.command, cwd, env);
  let startedAt = 0;
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
    o.onWait?.(true);
    for (;;) {
      if (aborted) return 128 + (aborted === "SIGINT" ? 2 : aborted === "SIGHUP" ? 1 : 15);
      if (await tryStart(o.dir, ticket.id, o.slots, o.deps)) break;
      if (Date.now() - lastBeat >= beat) {
        lastBeat = Date.now();
        out(await queuedLine(o.dir, ticket, started, o.deps));
      }
      await new Promise((r) => setTimeout(r, poll));
    }
    o.onWait?.(false);
    startedAt = Date.now();
    await patchTicket(o.dir, ticket.id, { paths, ...(kind === "test" ? { bootedBefore: bootedSimulators(o.simctl) } : {}) });
    out(`build started: ${label} (${mode}) — log ${buildLogPath(o.dir, ticket.id)}`);
    const code = await exec(wrap(o.command), { ...childEnv, PAI_BUILD_TICKET: ticket.id }, cwd, ticket, o, (c) => {
      child = c;
      if (aborted) killChild();
    });
    return aborted ? 128 + (aborted === "SIGINT" ? 2 : aborted === "SIGHUP" ? 1 : 15) : code;
  } finally {
    o.onWait?.(false);
    clearInterval(watch);
    if (kind === "test") {
      const t = await getTicket(o.dir, ticket.id);
      if (t?.bootedBefore) shutdownAdded(t.bootedBefore, o.simctl);
    }
    if (o.handleSignals) for (const s of sigs) process.off(s, onSig);
    if (startedAt) {
      const others = (await listBuilds(o.dir, o.deps)).filter((t) => t.id !== ticket.id).flatMap((t) => t.paths ?? []);
      await reapJob(paths, others, (Date.now() - startedAt) / 1000, o.reap);
    }
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
    const declared = new Set<string>();
    const declare = (p: string): void => {
      if (!ticket || declared.has(p)) return;
      declared.add(p);
      void patchTicket(o.dir, ticket.id, { logs: [...declared] });
    };
    if (env.PAI_BUILD_LOG) declare(env.PAI_BUILD_LOG);
    const onData = (b: Buffer): void => {
      log?.write(b);
      for (const p of declaredLogs(b.toString("utf8"))) declare(p);
    };
    child.stdout?.on("data", (b: Buffer) => {
      process.stdout.write(b);
      onData(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      process.stderr.write(b);
      onData(b);
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
export async function watchTicket(dir: string, id: string, deps: Partial<QueueDeps> = {}, intervalMs = 1000, simctl?: Simctl, reap?: ReapOptions): Promise<void> {
  const isAlive = deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (;;) {
    const t = await getTicket(dir, id);
    if (!t) return;
    if (!isAlive(t.pid)) {
      await listBuilds(dir, deps); // prune kills the group and removes the ticket
      if (t.kind === "test" && t.bootedBefore) shutdownAdded(t.bootedBefore, simctl);
      if (t.startedAt && t.paths?.length) {
        const others = (await listBuilds(dir, deps)).filter((x) => x.id !== t.id).flatMap((x) => x.paths ?? []);
        await reapJob(t.paths, others, (Date.now() - t.startedAt) / 1000, reap);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
