/**
 * pane-exec.ts — the pane owns the process.
 *
 * Everything PAI starts in a session (a headless worker, a plan runner, `pai pane run`, `pai build run`)
 * runs as the child of `pai pane exec <run-id>`, the command of a pane opened FIRST. Pane and process
 * therefore share one lifecycle: the wrapper starts the real command, shows its output in the pane,
 * writes <PAI home>/state/pane-exec/<run-id>.exit (code + end time) and exits when the child exits, so
 * the pane closes with it.
 *
 * The caller (`pai worker run`, `pai pane run`) listens on a unix socket <run-id>.sock before the pane
 * opens. The wrapper connects, announces itself (H), and waits for the caller's start frame (S: argv,
 * cwd, env, render mode) or cancel (C). Child stdout/stderr come back as o/e frames, the caller's stdin
 * goes in as i/I frames, signals as K. The caller sees an ordinary child process (`OwnedProc`) and
 * waits on it; either side going away takes the other with it (caller gone: the wrapper kills the
 * child's process group; wrapper gone: the caller kills the child).
 *
 * No terminal at all (no iTerm2/tmux): the caller runs the command directly, recorded "no terminal".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { paiHomePath } from "../config/pai-home.js";
import { startPaneBar, type PaneBar, type PaneBarDeps, type StatusLineSpec } from "./pane-bar.js";
import { panePolicy } from "./pane-policy.js";

export const PANE_EXEC_ENV = "PAI_PANE_EXEC";
/** Pid of the wrapper that spawned the process; only that wrapper's direct child is "already in its pane". */
export const PANE_EXEC_PID_ENV = "PAI_PANE_EXEC_PID";

export const paneExecDir = (): string => paiHomePath("state", "pane-exec");
export const exitFilePath = (id: string): string => join(paneExecDir(), `${id}.exit`);
export const recordPath = (id: string): string => join(paneExecDir(), `${id}.json`);
/** Unix socket path; the home path is hashed into /tmp when it would exceed the sockaddr limit. */
export function sockPath(id: string): string {
  const p = join(paneExecDir(), `${id}.sock`);
  return p.length < 100 ? p : join(tmpdir(), `pai-pe-${createHash("sha1").update(p).digest("hex").slice(0, 12)}.sock`);
}

/** The pane's command line: one exec-able line, no shell syntax (see followCommand). */
export function paneExecCommand(id: string, node = process.execPath, cli = process.argv[1] ?? "pai"): string {
  return `${node} ${cli.endsWith("pai") || cli.endsWith(".mjs") || cli.endsWith(".js") ? cli : "pai"} pane exec ${id}`;
}

export interface ExitRecord {
  id: string;
  code: number;
  endedMs: number;
  signal?: string;
  cancelled?: boolean;
  /** Why the wrapper ended the child itself ("caller gone", "pane closed"). */
  reason?: string;
}

export interface LaunchRecord {
  id: string;
  kind: string;
  caller: number;
  wrapper?: number;
  child?: number;
  /** The iTerm session the wrapper runs in (its ITERM_SESSION_ID): vouches that PAI opened this pane. */
  session?: string;
  /** When the pane opened and its wrapper said hello; the wrapper process starts here, however long the run then queues before `startedMs`. */
  openedMs?: number;
  /** When the command was started in the pane (after any slot-queue wait). */
  startedMs: number;
}

function writeJson(path: string, v: unknown): void {
  mkdirSync(paneExecDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v), "utf8");
  renameSync(tmp, path);
}

export function readExit(id: string): ExitRecord | null {
  try {
    return JSON.parse(readFileSync(exitFilePath(id), "utf8")) as ExitRecord;
  } catch {
    return null;
  }
}

export function readRecord(id: string): LaunchRecord | null {
  try {
    return JSON.parse(readFileSync(recordPath(id), "utf8")) as LaunchRecord;
  } catch {
    return null;
  }
}

export function listRecords(): LaunchRecord[] {
  try {
    return readdirSync(paneExecDir())
      .filter((n) => n.endsWith(".json"))
      .map((n) => readRecord(n.slice(0, -5)))
      .filter((r): r is LaunchRecord => r !== null);
  } catch {
    return [];
  }
}

export const pidAlive = (pid: number | undefined): boolean => {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

export const frame = (type: string, payload: Buffer | string = ""): Buffer => {
  const p = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const h = Buffer.alloc(5);
  h.write(type, 0, 1, "latin1");
  h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
};

export class FrameReader {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): Array<{ t: string; p: Buffer }> {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Array<{ t: string; p: Buffer }> = [];
    while (this.buf.length >= 5) {
      const n = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + n) break;
      out.push({ t: this.buf.toString("latin1", 0, 1), p: this.buf.subarray(5, 5 + n) });
      this.buf = this.buf.subarray(5 + n);
    }
    return out;
  }
}

export interface StartSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** "pipe": the caller writes to the child's stdin; "ignore": none. */
  stdin?: "pipe" | "ignore";
  /** plain: child output as is; stream: claude stream-json rendered like `worker follow`. */
  render?: "plain" | "stream";
  title?: string;
  /** Pin the status line (and, for a worker, the input line) at the pane's bottom. */
  statusLine?: StatusLineSpec;
  /** Seconds the pane stays after the child ended (0: closes with it). */
  linger?: number;
}

// ---------------------------------------------------------------------------
// the wrapper (runs in the pane)
// ---------------------------------------------------------------------------

export interface ExecDeps {
  out?: (s: string | Buffer) => void;
  err?: (s: string | Buffer) => void;
  setTitle?: (t: string) => void;
  /** Close the pane that runs this wrapper; called after the exit file is written. */
  closePane?: () => Promise<void>;
  /** Seconds the pane stays after the child ended (default: the pane policy). */
  linger?: number;
  env?: NodeJS.ProcessEnv;
  /** Process the signal handlers attach to (tests pass their own emitter). */
  proc?: NodeJS.Process;
  connectMs?: number;
  killGraceMs?: number;
  now?: () => number;
  /** Pane bar overrides (tests); a bar is drawn only when `tty` (default: stdout is a terminal). */
  tty?: boolean;
  bar?: Partial<PaneBarDeps>;
}

/** Longest the wrapper waits for its pane to be closed before it ends anyway. */
const CLOSE_WAIT_MS = 5000;

const SIG_NUM: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/** Runs in the pane: resolves to the exit code the wrapper process exits with. */
export async function runPaneExec(id: string, d: ExecDeps = {}): Promise<number> {
  const out = d.out ?? ((s) => process.stdout.write(s));
  const err = d.err ?? ((s) => process.stderr.write(s));
  const now = d.now ?? Date.now;
  const proc = d.proc ?? process;
  const grace = d.killGraceMs ?? panePolicy().killGraceMs;
  const finish = async (rec: Omit<ExitRecord, "id" | "endedMs">, clean?: number): Promise<number> => {
    writeJson(exitFilePath(id), { id, endedMs: now(), ...rec } satisfies ExitRecord);
    const failed = rec.code !== 0 && rec.reason !== "pane closed" && !rec.cancelled;
    const linger = clean ?? d.linger ?? panePolicy().exitLingerSecs;
    if (failed && linger > 0) err(`\n[failed (exit ${rec.code}) — this pane closes in ${linger}s; \`pai worker replay ${id}\` shows it again]\n`);
    if (linger > 0) await new Promise((r) => setTimeout(r, linger * 1000));
    // a close that hangs must not keep the wrapper (and with it the pane) alive
    await Promise.race([d.closePane?.().catch(() => undefined), new Promise((r) => setTimeout(r, CLOSE_WAIT_MS).unref())]);
    return rec.code;
  };

  const sock = await connect(sockPath(id), d.connectMs ?? panePolicy().connectMs);
  if (!sock) {
    err(`pai pane exec: no caller listens for ${id}; nothing to run\n`);
    return finish({ code: 1, reason: "no caller" });
  }
  const send = (t: string, p?: Buffer | string): void => {
    if (!sock.destroyed && sock.writable) sock.write(frame(t, p));
  };
  // Under tmux the ITERM_SESSION_ID is the operator's tab, inherited by the tmux server: not this pane's.
  const wenv = d.env ?? process.env;
  const session = wenv.TMUX ? undefined : wenv.ITERM_SESSION_ID || undefined;
  send("H", JSON.stringify({ pid: process.pid, session }));

  let child: ChildProcess | null = null;
  let spec: StartSpec | null = null;
  let stop: ((reason: string, sig?: string) => void) | null = null;
  let callerGone = false;
  let cancelled = false;
  let childEnded: Promise<void> | null = null;

  const killGroup = (sig: NodeJS.Signals): void => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* gone */
    }
  };

  const started = new Promise<void>((resolve) => {
    const rd = new FrameReader();
    sock.on("data", (chunk: Buffer) => {
      for (const f of rd.push(chunk)) {
        if (f.t === "S" && !child) {
          spec = JSON.parse(f.p.toString("utf8")) as StartSpec;
          resolve();
        } else if (f.t === "C") {
          cancelled = true;
          resolve();
        } else if (f.t === "i") child?.stdin?.write(f.p);
        else if (f.t === "I") child?.stdin?.end();
        else if (f.t === "K") {
          const sig = (JSON.parse(f.p.toString("utf8")) as { sig?: NodeJS.Signals }).sig ?? "SIGTERM";
          killGroup(sig);
        }
      }
    });
    const gone = (): void => {
      callerGone = true;
      resolve();
      stop?.("caller gone");
    };
    sock.on("close", gone);
    sock.on("error", () => undefined);
  });

  const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  let sigSeen: NodeJS.Signals | null = null;
  const onSig = (s: NodeJS.Signals): void => {
    sigSeen ??= s;
    callerGone = true;
    stop?.("pane closed", s);
  };
  const handlers = sigs.map((s) => {
    const h = (): void => onSig(s);
    proc.on(s, h);
    return h;
  });
  const cleanup = (): void => sigs.forEach((s, i) => proc.off(s, handlers[i]));

  await started;
  if (cancelled || callerGone || !spec) {
    cleanup();
    sock.destroy();
    return finish({ code: cancelled ? 0 : 143, cancelled, reason: cancelled ? "cancelled" : "caller gone" });
  }
  const sp: StartSpec = spec;
  if (sp.title) d.setTitle?.(sp.title);
  let bar: PaneBar | null = null;
  let show = out;
  let showErr = err;
  if (sp.statusLine && (d.tty ?? process.stdout.isTTY === true)) {
    const { loadStatus } = await import("./status.js");
    const { sayToWorker } = await import("./operator.js");
    const b = startPaneBar({
      spec: sp.statusLine,
      write: (x) => out(x),
      rows: () => process.stdout.rows || 24,
      columns: () => process.stdout.columns || null,
      input: process.stdin,
      loadStatus,
      say: sayToWorker,
      now,
      onResize: (cb) => void process.stdout.on("resize", cb),
      ...d.bar,
    });
    bar = b;
    const lines = (emit: (l: string) => void): ((x: string | Buffer) => void) => {
      let buf = "";
      return (x) => {
        const parts = (buf + x.toString()).split("\n");
        buf = parts.pop() ?? "";
        parts.forEach(emit);
      };
    };
    show = lines((l) => b.line(l));
    showErr = show;
  }
  const render = await renderer(sp, id, show, showErr);
  const t0 = now();
  const argv = sp.argv;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: sp.cwd,
      env: { ...(sp.env ?? process.env), ...(d.env ?? {}), [PANE_EXEC_ENV]: id, [PANE_EXEC_PID_ENV]: String(process.pid) } as NodeJS.ProcessEnv,
      detached: true,
      stdio: [sp.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (e) {
    send("E", (e as Error).message);
    cleanup();
    sock.end();
    return finish({ code: 127, reason: (e as Error).message });
  }
  const kid = child;
  let spawnError: Error | null = null;
  kid.on("error", (e) => {
    spawnError = e;
    if (!kid.pid) send("E", e.message);
  });
  if (kid.pid) send("P", JSON.stringify({ pid: kid.pid }));

  let stopReason = "";
  stop = (reason, sig) => {
    stopReason ||= reason;
    killGroup((sig as NodeJS.Signals) ?? "SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), grace).unref();
  };
  if (callerGone) stop(sigSeen ? "pane closed" : "caller gone", sigSeen ?? undefined);

  kid.stdout?.on("data", (c: Buffer) => {
    send("o", c);
    render.out(c);
  });
  kid.stderr?.on("data", (c: Buffer) => {
    send("e", c);
    render.err(c);
  });
  childEnded = new Promise<void>((r) => kid.on("close", () => r()));
  const code = await new Promise<number>((resolve) => {
    kid.on("error", () => resolve(127));
    kid.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (SIG_NUM[sig] ?? 0) : 1)));
  });
  await childEnded;
  killGroup("SIGKILL"); // stragglers of the group
  cleanup();
  render.end();
  const took = Math.round((now() - t0) / 1000);
  showErr(`\n[exit ${code}${stopReason ? ` (${stopReason})` : ""} after ${took}s]\n`);
  bar?.stop();
  const rec: Omit<ExitRecord, "id" | "endedMs"> = { code, ...(stopReason ? { reason: stopReason } : {}), ...(spawnError ? { reason: (spawnError as Error).message } : {}) };
  writeJson(exitFilePath(id), { id, endedMs: now(), ...rec } satisfies ExitRecord);
  send("X", JSON.stringify({ code }));
  await new Promise<void>((r) => (sock.destroyed ? r() : sock.end(() => r())));
  return finish(rec, sp.linger);
}

async function renderer(sp: StartSpec, id: string, out: (s: string | Buffer) => void, err: (s: string | Buffer) => void): Promise<{ out: (c: Buffer) => void; err: (c: Buffer) => void; end: () => void }> {
  if (sp.render !== "stream") return { out: (c) => out(c), err: (c) => err(c), end: () => undefined };
  const { applyEvent, initialFollowState } = await import("./viewer.js");
  const { makeColor } = await import("./render.js");
  const c = makeColor(true);
  let state = initialFollowState("");
  let buf = "";
  const cwd = sp.cwd ?? process.cwd();
  const line = (ln: string): void => {
    if (!ln.trim()) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      out(ln + "\n");
      return;
    }
    try {
      const step = applyEvent(c, state, { ...e, _ts: new Date().toISOString() } as never, cwd, undefined, undefined, typeof process.stdout.columns === "number" ? process.stdout.columns : null);
      state = step.state;
      if (step.day) out(c("dim", `── ${step.day} ──`) + "\n");
      for (const l of step.lines) out(l + "\n");
    } catch {
      out(ln + "\n");
    }
  };
  return {
    out: (chunk) => {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      parts.forEach(line);
    },
    err: (chunk) => err(c("dim", chunk.toString("utf8"))),
    end: () => {
      line(buf);
      buf = "";
    },
  };
  void id;
}

function connect(path: string, waitMs: number): Promise<Socket | null> {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const s = createConnection(path);
      s.once("connect", () => resolve(s));
      s.once("error", () => {
        s.destroy();
        if (Date.now() >= deadline) resolve(null);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// the caller side
// ---------------------------------------------------------------------------

/** A child process seen through the wrapper: what executeRun/runInPane use of ChildProcess. */
export class OwnedProc extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable | null;
  constructor(private readonly sock: Socket, stdin: boolean, private readonly onKill: (sig: NodeJS.Signals) => void) {
    super();
    this.stdin = stdin
      ? new Writable({
          write: (chunk, _enc, cb) => {
            if (!this.sock.destroyed) this.sock.write(frame("i", chunk as Buffer));
            cb();
          },
          final: (cb) => {
            if (!this.sock.destroyed) this.sock.write(frame("I"));
            cb();
          },
        })
      : null;
  }
  kill(sig: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.onKill(typeof sig === "number" ? "SIGTERM" : sig);
    return true;
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

export interface OwnedPane {
  id: string;
  /** Start the command in the pane; resolves once the wrapper has the child running. */
  start(spec: StartSpec): Promise<OwnedProc>;
  /** The command will not run: the wrapper exits and the pane closes. */
  cancel(): void;
  /** Description from the pane opener. */
  where: string;
}

export interface OpenOwnedOptions {
  id: string;
  kind: string;
  /** Opens the pane running `command` (the wrapper); resolves to a description, rejects when it cannot. */
  open: (command: string) => Promise<string>;
  /** Closes the pane again when the wrapper never came up. */
  closeFailed?: () => Promise<unknown>;
  helloMs?: number;
  /** Wrapper command line (tests pass their own). */
  command?: string;
}

const live = new Set<OwnedPane>();
let exitHooked = false;

/**
 * Open the pane FIRST: the caller listens, the pane's wrapper connects. Rejects (the pane just opened
 * is closed again) when the pane cannot open or its wrapper does not come up.
 */
export async function openOwnedPane(o: OpenOwnedOptions): Promise<OwnedPane> {
  mkdirSync(paneExecDir(), { recursive: true });
  for (const f of [exitFilePath(o.id), sockPath(o.id)]) rmQuiet(f);
  let wrapper = 0;
  let session: string | undefined;
  let sock: Socket | null = null;
  let server!: Server;
  const connected = new Promise<Socket>((resolve) => {
    server = createServer((s) => {
      sock = s;
      server.close();
      resolve(s);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath(o.id), resolve);
  });
  const fail = async (e: Error): Promise<never> => {
    server.close();
    (sock as Socket | null)?.destroy();
    rmQuiet(sockPath(o.id));
    await o.closeFailed?.().catch(() => undefined);
    throw e;
  };
  let where: string;
  try {
    where = await o.open(o.command ?? paneExecCommand(o.id));
  } catch (e) {
    return fail(e instanceof Error ? e : new Error(String(e)));
  }
  const s = await Promise.race([
    connected,
    new Promise<null>((r) => setTimeout(() => r(null), o.helloMs ?? panePolicy().helloWaitMs).unref()),
  ]);
  if (!s) return fail(new Error(`pane opened (${where}) but its wrapper did not connect`));
  rmQuiet(sockPath(o.id));
  const rd = new FrameReader();
  let proc: OwnedProc | null = null;
  let pidWaiter: { ok: (p: OwnedProc) => void; bad: (e: Error) => void } | null = null;
  let ended = false;
  let startedAt = 0;
  const openedAt = Date.now();
  const record = (extra: Partial<LaunchRecord> = {}): void => writeJson(recordPath(o.id), { id: o.id, kind: o.kind, caller: process.pid, wrapper: wrapper || undefined, session, openedMs: openedAt, startedMs: startedAt || openedAt, ...extra } satisfies LaunchRecord);
  const settle = (code: number, signal?: string): void => {
    if (ended) return;
    ended = true;
    live.delete(pane);
    clearInterval(watch);
    if (proc) {
      proc.exitCode = code;
      proc.stdout.end();
      proc.stderr.end();
      proc.emit("exit", code, signal ?? null);
      proc.emit("close", code, signal ?? null);
    } else pidWaiter?.bad(new Error("the pane's wrapper ended before the command started"));
    s.destroy();
  };
  // a wrapper that vanished without its X frame: read the exit file, else the command died with it
  const lost = (): void => {
    if (ended) return;
    const ex = readExit(o.id);
    if (!ex && proc?.pid && pidAlive(proc.pid)) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    settle(ex?.code ?? 143);
  };
  s.on("data", (chunk: Buffer) => {
    for (const f of rd.push(chunk)) {
      if (f.t === "H") {
        const hello = JSON.parse(f.p.toString("utf8")) as { pid: number; session?: string };
        wrapper = hello.pid;
        session = hello.session || undefined;
        record();
      } else if (f.t === "P" && proc) {
        proc.pid = (JSON.parse(f.p.toString("utf8")) as { pid: number }).pid;
        record({ child: proc.pid });
        pidWaiter?.ok(proc);
        pidWaiter = null;
      } else if (f.t === "E") pidWaiter?.bad(new Error(f.p.toString("utf8")));
      else if (f.t === "o") proc?.stdout.write(f.p);
      else if (f.t === "e") proc?.stderr.write(f.p);
      else if (f.t === "X") settle((JSON.parse(f.p.toString("utf8")) as { code: number }).code);
    }
  });
  s.on("close", lost);
  s.on("error", () => undefined);
  const watch = setInterval(() => {
    if (wrapper && !pidAlive(wrapper)) lost();
  }, 1000);
  watch.unref();
  const pane: OwnedPane = {
    id: o.id,
    where,
    start: (spec) =>
      new Promise<OwnedProc>((ok, bad) => {
        if (ended) return bad(new Error("the pane's wrapper has ended"));
        startedAt = Date.now();
        proc = new OwnedProc(s, spec.stdin === "pipe", (sig) => {
          if (!s.destroyed) s.write(frame("K", JSON.stringify({ sig })));
        });
        pidWaiter = { ok, bad };
        s.write(frame("S", JSON.stringify(spec)));
      }),
    cancel: () => {
      if (ended) return;
      if (!s.destroyed) s.write(frame("C"));
      ended = true;
      live.delete(pane);
      clearInterval(watch);
      s.end();
    },
  };
  live.add(pane);
  if (!exitHooked) {
    exitHooked = true;
    // a caller going away takes its panes with it: no wrapper waits for a command that never starts
    process.on("exit", () => live.forEach((p) => p.cancel()));
  }
  return pane;
}

function rmQuiet(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* gone */
  }
}
