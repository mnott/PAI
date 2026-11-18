/**
 * budget.ts — `pai budget`: the machine-wide local-only window and its
 * gatekeeper approvals.
 *
 *   pai budget local-only --until "YYYY-MM-DD HH:MM"   open the window
 *   pai budget local-only off                          close it
 *   pai budget status                                  what stands now
 *   pai budget approve <worker id or label> [--for 2h] one-time cloud pass, gatekeeper session only
 *
 * The state lives in <PAI_HOME>/state/local-only.json (src/workers/local-only.ts);
 * every refusal and approval lands in the routing ledger.
 */

import { CliError, type CommandDef } from "../define.js";
import {
  addApproval,
  clearLocalOnly,
  gatekeeperSession,
  isGatekeeperSession,
  localOnlyBanner,
  parseLocalStamp,
  parseWindowDuration,
  readLocalOnly,
  setLocalOnly,
} from "../../workers/local-only.js";
import { ledgerPath, workersLogDir } from "../../workers/paths.js";
import { appendLedger } from "../../workers/ledger.js";
import { readWorkersSection } from "../../workers/config.js";

const out = (s: string) => process.stdout.write(s + "\n");

/** Run a verb; any thrown error becomes one plain sentence (exit 1) with the next command. */
async function budgetGuard(next: string, fn: () => Promise<void>): Promise<number | void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(e instanceof Error ? e.message : String(e), next);
  }
}

function logDirNow(): string {
  try {
    return workersLogDir(readWorkersSection().workers);
  } catch {
    return "";
  }
}

const localOnlyCommand: CommandDef = {
  name: "local-only",
  summary: "The machine-wide local-only window: no cloud starts until --until (off closes it)",
  description:
    "While the window is open every session's cloud start (--cloud, --provider/--where naming a cloud provider, a class whose route resolves to the cloud) is refused, automatic escalation never targets the cloud, and reroutes to the cloud are refused. The operator's own moves (pai worker reroute, the cockpit) always pass; the gatekeeper session (`pai budget approve`, config key budget.gatekeeper, default \"PAI\") can open a one-time exception.",
  args: [{ name: "off", summary: "\"off\" closes the window; with --until it opens it" }],
  options: [
    { name: "until", type: "string", value: "WHEN", summary: "Close the cloud until this local time, \"YYYY-MM-DD HH:MM\" (e.g. \"2026-11-21 07:00\")" },
  ],
  examples: ['pai budget local-only --until "2026-11-21 07:00"', "pai budget local-only off", "pai budget status"],
  seeAlso: ["pai budget status", "pai budget approve"],
  run: (ctx) => budgetGuard('pai budget local-only --until "YYYY-MM-DD HH:MM"', async () => {
      const until = typeof ctx.opts.until === "string" ? ctx.opts.until : undefined;
      if (ctx.args.off === "off") {
        clearLocalOnly();
        const dir = logDirNow();
        if (dir) appendLedger(ledgerPath(dir), "LOCAL-ONLY-OFF", {});
        out("local-only window: off");
        return;
      }
      if (!until) throw new Error('--until "YYYY-MM-DD HH:MM" is required (or "pai budget local-only off")');
      const ms = parseLocalStamp(until);
      if (ms === null) throw new Error(`--until: expected "YYYY-MM-DD HH:MM", got "${until}"`);
      if (ms <= Date.now()) throw new Error(`--until: "${until}" is already past`);
      const st = setLocalOnly(ms, "cli");
      const dir = logDirNow();
      if (dir) appendLedger(ledgerPath(dir), "LOCAL-ONLY-SET", { until: st.label });
      out(`local only until ${st.label}`);
    }),
};

const statusCommand: CommandDef = {
  name: "status",
  summary: "The local-only window and the gatekeeper session, as they stand now",
  run: (ctx) => budgetGuard("pai budget status", async () => {
      const w = readLocalOnly();
      out(w ? `local only until ${w.label}` : "local-only window: off");
      out(`gatekeeper session: ${gatekeeperSession()}`);
    }),
};

const approveCommand: CommandDef = {
  name: "approve",
  summary: "One-time cloud pass for one worker, from the gatekeeper session only",
  description:
    "Writes a one-time approval token the next matching cloud start consumes. Only the configured gatekeeper session (budget.gatekeeper, default \"PAI\") may approve, and only when it runs this itself.",
  args: [{ name: "WORKER", required: true, summary: "The worker id or label to let through the window once" }],
  options: [{ name: "for", type: "string", value: "DURATION", summary: "How long the token stands (30m, 2h, 1d; default 2h)" }],
  examples: ['pai budget approve 20261118-211428-86670', 'pai budget approve "fix the retry loop" --for 4h'],
  seeAlso: ["pai budget local-only", "pai budget status"],
  run: (ctx) => budgetGuard('pai budget approve <worker id or label> [--for 2h]', async () => {
      const worker = String(ctx.args.WORKER ?? "").trim();
      if (!worker) throw new Error("a worker id or label is required");
      if (!(await isGatekeeperSession())) {
        throw new Error(`only the gatekeeper session ("${gatekeeperSession()}") may approve a cloud run — this session is not it`);
      }
      const forMs = typeof ctx.opts.for === "string" ? parseWindowDuration(ctx.opts.for) : 2 * 3_600_000;
      addApproval(worker, forMs);
      const dir = logDirNow();
      const until = new Date(Date.now() + forMs).toISOString();
      if (dir) appendLedger(ledgerPath(dir), "LOCAL-ONLY-APPROVED", { worker, by: gatekeeperSession(), until });
      out(`approved ${worker}: the next cloud start matching it passes the window (token valid ${Math.round(forMs / 60_000)}m)`);
    }),
};

export const budgetCommand: CommandDef = {
  name: "budget",
  summary: "The local-only budget window: local-only, status, approve",
  description:
    "`pai budget local-only --until \"YYYY-MM-DD HH:MM\"` closes the cloud machine-wide until that time; `off` reopens it. While open, cloud starts and automatic cloud moves are refused with \"local-only window until <time> (budget): ask the PAI session to approve a cloud run\"; the gatekeeper session approves single runs through (`pai budget approve`). The operator's own reroutes always pass.",
  examples: ['pai budget local-only --until "2026-11-21 07:00"', "pai budget status", "pai budget approve 20261118-211428-86670"],
  seeAlso: ["pai worker mode", "pai freeze"],
  subcommands: [localOnlyCommand, statusCommand, approveCommand],
  run: (ctx) => budgetGuard("pai budget status", async () => {
      out("usage: pai budget local-only --until \"YYYY-MM-DD HH:MM\" | off · pai budget status · pai budget approve <id|label> [--for 2h]");
    }),
};
