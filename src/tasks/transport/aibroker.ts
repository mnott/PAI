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
import type { Transport, TransportResult } from "../dispatch.js";

/** Long enough to cover launching a terminal tab and waiting for it to settle. */
const DISPATCH_TIMEOUT_MS = 60_000;

interface WireResult {
  outcome?: string;
  project?: string;
  session?: string;
  reason?: string;
}

const VALID_OUTCOMES = new Set([
  "delivered",
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
function run(bin: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: DISPATCH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
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
  constructor(private readonly bin = "aibroker") {}

  async dispatch(
    project: string,
    message: string,
    opts: { spawnIfAbsent: boolean },
  ): Promise<TransportResult> {
    const args = ["dispatch", project, "--stdin", "--json"];
    if (!opts.spawnIfAbsent) args.push("--no-spawn");

    const stdout = await run(this.bin, args, message);

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
 * Return a transport if the `aibroker` CLI is present and supports dispatch.
 *
 * Probing for the subcommand rather than just the binary matters: AIBroker
 * shipped for a long time without `dispatch`, and an older install would
 * otherwise fail once per task instead of degrading cleanly up front.
 */
export async function detectAiBroker(bin = "aibroker"): Promise<Transport | null> {
  try {
    const help = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["help"], { timeout: 10_000 }, (error, stdout, stderr) => {
        if (error && !stdout) reject(error);
        else resolve(stdout + stderr);
      });
    });
    return help.includes("dispatch") ? new AiBrokerTransport(bin) : null;
  } catch {
    return null;
  }
}
