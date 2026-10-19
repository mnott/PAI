/**
 * hang-probe.ts — `pai worker test-run -- <command>`: runs a test command and, when it goes silent,
 * tells the model WHERE it is stuck.
 *
 * A synchronous infinite loop blocks Node's event loop, so the test runner cannot even report its own
 * timeout and the model sees nothing. Node's `--report-on-signal` does not help: it is serviced by the
 * event loop (measured: a `while(true){}` process never writes the report). The child therefore runs with a
 * preloaded watchdog (NODE_OPTIONS --require): a worker thread per process that, when a trigger file appears,
 * attaches the inspector to the main thread, pauses it (V8 interrupts a running loop) and writes the call
 * frames. After the command was silent for the idle threshold the wrapper triggers every node process under
 * it and maps the frames to the worktree's files. The worker guard rewrites test commands into this wrapper
 * (see wrapTestCommand).
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Marker line every diagnosis carries; the loop guard keys on it. */
export const HANG_MARKER = "[pai hang probe]";
export const DEFAULT_IDLE_SECS = 60;
const WRAP = "pai worker test-run";

const TEST_RUNNER = /^(?:npx\s+|bunx\s+|pnpm (?:exec\s+)?|yarn\s+)?(?:vitest|jest|node\s+(?:\S+\s+)*--test\b|npm (?:run )?test|pnpm (?:run )?test|yarn test)\b/;

/** Command segments of a shell line, with env prefixes, nohup, `timeout N` and cd removed. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/).map((raw) => {
    let seg = raw.replace(/["']/g, "").trim();
    for (;;) {
      const next = seg
        .replace(/^(?:[A-Za-z_]\w*=\S*\s+)/, "")
        .replace(/^nohup\s+/, "")
        .replace(/^(?:timeout|gtimeout)\s+(?:-\S+\s+)*\d+\w*\s+/, "")
        .replace(/^cd\s+\S+\s*/, "");
      if (next === seg) return seg;
      seg = next;
    }
  });
}

/** True when a foreground part of the command runs a test runner (vitest, jest, node --test, npm test). */
export function isTestCommand(command: string): boolean {
  if (command.includes(WRAP) || /&\s*$|\bnohup\b/.test(command.trim())) return false; // already wrapped; detached jobs are polled
  return segments(command).some((s) => TEST_RUNNER.test(s));
}

/** Seconds of the first `timeout N` in the command, else null. */
export function timeoutSecs(command: string): number | null {
  const m = /\b(?:g?timeout)\s+(?:-[ks]\s+\S+\s+|-\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)\b/.exec(command);
  if (!m) return null;
  return Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
}

function killQuiet(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // gone
  }
}

function rmQuiet(f: string): void {
  try {
    unlinkSync(f);
  } catch {
    // already consumed
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command the guard runs instead: the original inside the probe wrapper. */
export function wrapTestCommand(command: string): string {
  return `${WRAP} -- bash -c ${shq(command)}`;
}

export interface Frame {
  fn: string;
  file: string;
  line: number;
}

/** One call frame as the inspector reports it (line 0-based). */
export interface RawFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

/** Call frames of one probed process, user code only, files relative to cwd. */
export function userFrames(frames: RawFrame[], cwd: string): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) {
    let file = f.url;
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (!file || file.startsWith("node:") || file.includes("node_modules") || !isAbsolute(file)) continue;
    const rel = relative(cwd, file);
    if (rel.startsWith("..")) continue;
    out.push({ fn: f.functionName || "(anonymous)", file: rel, line: f.lineNumber + 1 });
  }
  return out;
}

/** The model-facing diagnosis for the reports taken after `idleSecs` of silence. */
export function diagnose(probed: RawFrame[][], cwd: string, idleSecs: number): string {
  const stuck = probed.map((r) => userFrames(r, cwd)).find((f) => f.length > 0);
  if (stuck) {
    const [top, ...rest] = stuck;
    const via = rest[0] ? ` (called from ${rest[0].file}:${rest[0].line} ${rest[0].fn}())` : "";
    return (
      `${HANG_MARKER} test run hung with no output for ${idleSecs} s; the main thread is stuck in ${top.file}:${top.line} ${top.fn}()${via}. ` +
      `A synchronous loop that never ends blocks the runner's own timeout. Fix that loop; rerunning unchanged will hang again.\n` +
      stuck.slice(0, 6).map((f) => `  at ${f.fn} (${f.file}:${f.line})`).join("\n")
    );
  }
  return (
    `${HANG_MARKER} test run printed nothing for ${idleSecs} s and the main thread is idle in the event loop: it is waiting (async), not spinning. ` +
    `A test awaits a promise, timer, process or socket that never completes (vitest's own per-test timeout ends it unless the test raised it). Find the await and give it an end; rerunning unchanged will wait again.`
  );
}

interface ProcRow {
  pid: number;
  ppid: number;
  cmd: string;
}

function listProcs(): ProcRow[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5_000 });
    return out.split("\n").flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }] : [];
    });
  } catch {
    return [];
  }
}

/** Pids of node processes below `root`. */
export function nodeDescendants(root: number, procs: ProcRow[] = listProcs()): number[] {
  const seen = new Set<number>([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (!seen.has(p.pid) && seen.has(p.ppid)) (seen.add(p.pid), (grew = true));
  }
  return procs.filter((p) => p.pid !== root && seen.has(p.pid) && /(?:^|\/)node(?:\s|$)/.test(p.cmd)).map((p) => p.pid);
}

export interface ProbeOptions {
  command: string;
  cwd: string;
  reportDir: string;
  idleSecs?: number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** Runs the command, passes its output through, probes once when it goes silent. Resolves to the exit code. */
export async function runProbed(o: ProbeOptions): Promise<number> {
  const out = o.out ?? ((s) => process.stdout.write(s));
  const err = o.err ?? ((s) => process.stderr.write(s));
  mkdirSync(o.reportDir, { recursive: true });
  const t = timeoutSecs(o.command);
  // probe before a `timeout N` in the command kills the run
  const idle = Math.max(2, Math.min(o.idleSecs ?? DEFAULT_IDLE_SECS, t !== null ? t - 8 : Infinity));
  const preload = join(o.reportDir, "preload.cjs");
  writeFileSync(preload, PRELOAD_SOURCE);
  const env = {
    ...process.env,
    PAI_HANG_PROBE_DIR: o.reportDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim(),
  };
  const child = spawn("bash", ["-c", o.command], { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let last = Date.now();
  let probed = false;
  let spun = false;
  let pending: Promise<void> = Promise.resolve();
  child.stdout.on("data", (d: Buffer) => ((last = Date.now()), out(d.toString())));
  child.stderr.on("data", (d: Buffer) => ((last = Date.now()), err(d.toString())));
  const timer = setInterval(() => {
    if (probed || Date.now() - last < idle * 1000 || !child.pid) return;
    probed = true;
    const pids = nodeDescendants(child.pid);
    for (const p of pids) writeFileSync(join(o.reportDir, `probe-${p}`), "");
    pending = collectFrames(o.reportDir, pids, 3000).then((frames) => {
      for (const p of pids) rmQuiet(join(o.reportDir, `probe-${p}`));
      err(`\n${diagnose(frames, o.cwd, idle)}\n`);
      // a spinning loop never ends: stop the run now so the model gets the diagnosis, not a Bash timeout
      if (frames.some((f) => userFrames(f, o.cwd).length > 0)) {
        spun = true;
        for (const p of [...pids, child.pid as number]) killQuiet(p, "SIGTERM");
        setTimeout(() => pids.forEach((p) => killQuiet(p, "SIGKILL")), 2000).unref();
      }
    });
  }, 1000);
  return await new Promise<number>((resolve) => {
    child.on("close", (code, sig) => {
      clearInterval(timer);
      void pending.then(() => resolve(spun ? 124 : (code ?? (sig ? 128 + (sig === "SIGKILL" ? 9 : 15) : 1))));
    });
  });
}

/** Frames each probed pid reported (empty list: its main thread was idle); pids that never answered are left out. */
async function collectFrames(dir: string, pids: number[], waitMs: number): Promise<RawFrame[][]> {
  const got = new Map<number, RawFrame[]>();
  for (const end = Date.now() + waitMs; Date.now() < end && got.size < pids.length; ) {
    for (const p of pids) {
      const f = join(dir, `frames-${p}.json`);
      if (got.has(p) || !existsSync(f)) continue;
      try {
        got.set(p, (JSON.parse(readFileSync(f, "utf8")) as { frames: RawFrame[] }).frames);
        unlinkSync(f);
      } catch {
        // half-written; next round
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return [...got.values()];
}

/** Preloaded into every node process of the test run (CommonJS, so it also loads under --require). */
export const PRELOAD_SOURCE = `"use strict";
const { Worker, isMainThread } = require("node:worker_threads");
if (isMainThread) {
  const code = \`
    const { existsSync, unlinkSync, writeFileSync, renameSync } = require("node:fs");
    const { Session } = require("node:inspector");
    const { workerData } = require("node:worker_threads");
    const trigger = workerData.dir + "/probe-" + workerData.pid;
    const done = (frames) => {
      const tmp = workerData.dir + "/tmp-" + workerData.pid;
      writeFileSync(tmp, JSON.stringify({ frames }));
      renameSync(tmp, workerData.dir + "/frames-" + workerData.pid + ".json");
    };
    setInterval(() => {
      if (!existsSync(trigger)) return;
      try { unlinkSync(trigger); } catch {}
      const s = new Session();
      s.connectToMainThread();
      let answered = false;
      const urls = {}, maps = {};
      s.on("Debugger.scriptParsed", (m) => { urls[m.params.scriptId] = m.params.url; maps[m.params.scriptId] = m.params.sourceMapURL; });
      // transformed code (vite-node, tsx) has shifted lines: map back through its inline source map
      const where = (f) => {
        const id = f.location.scriptId;
        let url = urls[id] || f.url, line = f.location.lineNumber;
        const m = /^data:[^,]*;base64,(.*)$/.exec(maps[id] || "");
        if (m) try {
          const e = new (require("node:module").SourceMap)(JSON.parse(Buffer.from(m[1], "base64").toString())).findEntry(line, f.location.columnNumber || 0);
          if (e && e.originalSource) { url = new URL(e.originalSource, url).href; line = e.originalLine; }
        } catch {}
        return { functionName: f.functionName, url, lineNumber: line };
      };
      s.on("Debugger.paused", (m) => {
        answered = true;
        done(m.params.callFrames.map(where));
        s.post("Debugger.resume", () => s.post("Debugger.disable", () => s.disconnect()));
      });
      s.post("Debugger.enable", () => s.post("Debugger.pause"));
      // an idle event loop runs no JS to pause in
      setTimeout(() => { if (!answered) { done([]); s.post("Debugger.disable", () => s.disconnect()); } }, 800);
    }, 200);
  \`;
  try {
    new Worker(code, { eval: true, workerData: { dir: process.env.PAI_HANG_PROBE_DIR, pid: process.pid } }).unref();
  } catch {}
}
`;
