/**
 * aibroker.ts — AIBroker transport for the task bus
 *
 * Shells out to the `aibroker` CLI. PAI's CLI cannot call MCP tools, so the
 * MCP-only dispatch primitives are unreachable from a shell — this is the
 * bridge.
 *
 * Optional by design: when AIBroker is not installed, `detect()` returns null
 * and the bus reports ownership instead of delivering. PAI must stay useful on
 * machines that do not run iTerm2.
 *
 * See Notes/docs/task-bus.md.
 */

import { execFile } from "node:child_process";
import type { ProbeAnswer } from "../poller.js";
import type { Transport, TransportResult } from "../dispatch.js";

/**
 * How long AIBroker may spend on one dispatch, in seconds.
 *
 * A cold spawn measured ~10s on an idle machine, but boot time is not bounded:
 * under load a session can take considerably longer to start accepting input.
 */
const DEFAULT_DISPATCH_TIMEOUT_SECS = 180;

/**
 * Margin between AIBroker's own deadline and when we kill the process.
 *
 * These two timeouts must never disagree. If ours fired first we would kill a
 * dispatch mid-flight and report a transport failure that AIBroker cannot
 * reproduce from its own CLI — a phantom bug, in the other repo, with no trace
 * on either side. So we always pass our budget down via `--timeout` and give
 * it room to time out first and tell us why.
 */
const KILL_MARGIN_MS = 15_000;

interface WireResult {
  outcome?: string;
  project?: string;
  session?: string;
  reason?: string;
}

const VALID_OUTCOMES = new Set([
  "delivered",
  "queued",
  "spawned",
  "unlaunchable",
  "unreachable",
  "skipped",
]);

/**
 * Run `aibroker dispatch`, feeding the message over stdin.
 *
 * stdin rather than argv is deliberate: task bodies carry the full procedure
 * and reasoning, so they are long, multi-line, and full of quotes and
 * backticks. argv would mangle them or hit length limits.
 */
function run(bin: string, args: string[], stdin: string, killAfterMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: killAfterMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        // A non-zero exit carrying parseable JSON is a reported outcome, not a
        // crash — let the caller interpret it rather than throwing here.
        if (error && !stdout.trim().startsWith("{")) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(stdin);
  });
}

export class AiBrokerTransport implements Transport {
  constructor(
    private readonly bin = "aibroker",
    private readonly timeoutSecs = DEFAULT_DISPATCH_TIMEOUT_SECS,
  ) {}

  async dispatch(
    project: string,
    message: string,
    opts: { spawnIfAbsent: boolean },
  ): Promise<TransportResult> {
    const args = ["dispatch", project, "--stdin", "--json", "--timeout", String(this.timeoutSecs)];
    if (!opts.spawnIfAbsent) args.push("--no-spawn");

    const stdout = await run(
      this.bin,
      args,
      message,
      this.timeoutSecs * 1000 + KILL_MARGIN_MS,
    );

    // The CLI prints diagnostics before its JSON, so take the last JSON object
    // rather than assuming stdout is clean.
    const start = stdout.lastIndexOf("{");
    if (start === -1) {
      throw new Error(`aibroker returned no JSON: ${stdout.trim().slice(0, 200)}`);
    }

    let wire: WireResult;
    try {
      wire = JSON.parse(stdout.slice(start)) as WireResult;
    } catch {
      throw new Error(`aibroker returned malformed JSON: ${stdout.trim().slice(0, 200)}`);
    }

    // Treat an unrecognised outcome as unlaunchable rather than trusting it.
    // Silently passing through an unknown string would report success for a
    // task that never arrived.
    if (!wire.outcome || !VALID_OUTCOMES.has(wire.outcome)) {
      return {
        outcome: "unlaunchable",
        session: wire.session ?? project,
        reason: `unexpected outcome from aibroker: ${String(wire.outcome)}`,
      };
    }

    return {
      outcome: wire.outcome as TransportResult["outcome"],
      session: wire.session ?? wire.project ?? project,
      reason: wire.reason,
    };
  }
}

/**
 * Liveness prober backed by `aibroker ask`.
 *
 * Separate from Transport on purpose: asking must NEVER spawn. A probe that
 * creates the session it is probing for turns "this session died" into "all is
 * well", which is the failure the probe exists to catch.
 */
export class AiBrokerProber {
  constructor(
    private readonly bin = "aibroker",
    private readonly timeoutSecs = 60,
  ) {}

  async ask(project: string, question: string): Promise<ProbeAnswer> {
    let stdout: string;
    try {
      stdout = await run(
        this.bin,
        ["ask", project, "--stdin", "--json", "--timeout", String(this.timeoutSecs)],
        question,
        this.timeoutSecs * 1000 + KILL_MARGIN_MS,
      );
    } catch (e) {
      return { state: "silent", reason: e instanceof Error ? e.message : String(e) };
    }

    const start = stdout.lastIndexOf("{");
    if (start === -1) return { state: "silent", reason: "aibroker returned no JSON" };

    try {
      const wire = JSON.parse(stdout.slice(start)) as {
        replied?: boolean;
        reply?: string;
        reason?: string;
        state?: string;
      };

      // Trust `state` when present. Fall back to `replied` for an older
      // aibroker that predates it — but never infer "busy" from silence, which
      // is the whole reason the fourth state exists.
      const state = wire.state ?? (wire.replied === true ? "replied" : "silent");
      if (state === "replied" || state === "busy" || state === "silent" || state === "absent") {
        return { state, reply: wire.reply, reason: wire.reason };
      }
      // An unrecognised state must not read as healthy.
      return { state: "silent", reason: `unexpected state from aibroker: ${String(wire.state)}` };
    } catch {
      return { state: "silent", reason: "aibroker returned malformed JSON" };
    }
  }
}

/**
 * Return a prober if the installed `aibroker` supports `ask`.
 *
 * Probes for the subcommand rather than the binary: an older AIBroker would
 * otherwise fail once per stuck task instead of the scheduler simply knowing it
 * has no liveness check and saying so.
 */
export async function detectProber(bin = "aibroker"): Promise<AiBrokerProber | null> {
  try {
    const help = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["help"], { timeout: 10_000 }, (error, stdout, stderr) => {
        if (error && !stdout) reject(error);
        else resolve(stdout + stderr);
      });
    });
    return /\bask\b/.test(help) ? new AiBrokerProber(bin) : null;
  } catch {
    return null;
  }
}

/**
 * Return a transport if the `aibroker` CLI is present and supports dispatch.
 *
 * Probing for the subcommand rather than just the binary matters: AIBroker
 * shipped for a long time without `dispatch`, and an older install would
 * otherwise fail once per task instead of degrading cleanly up front.
 */
export async function detectAiBroker(
  bin = "aibroker",
  timeoutSecs = DEFAULT_DISPATCH_TIMEOUT_SECS,
): Promise<Transport | null> {
  try {
    const help = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["help"], { timeout: 10_000 }, (error, stdout, stderr) => {
        if (error && !stdout) reject(error);
        else resolve(stdout + stderr);
      });
    });
    return help.includes("dispatch") ? new AiBrokerTransport(bin, timeoutSecs) : null;
  } catch {
    return null;
  }
}
