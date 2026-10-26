/** `pai now`: open, show or clear the operator's urgency window (workers/urgency.ts). */

import { CliError, type CommandDef, type RunContext } from "../define.js";
import { clearUrgency, DEFAULT_URGENCY_WINDOW_MIN, listUrgency, readUrgencyFor, recordUrgency } from "../../workers/urgency.js";
import { detectSessionName } from "../../workers/session-name.js";
import { readWorkersSection } from "../../workers/config.js";

function windowMinutes(): number {
  try {
    return readWorkersSection().workers.urgency?.windowMinutes ?? DEFAULT_URGENCY_WINDOW_MIN;
  } catch {
    return DEFAULT_URGENCY_WINDOW_MIN;
  }
}

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const stateLine = (key: string, until: number, where?: "local"): string =>
  `urgent for ${key}: now${where === "local" ? ", local" : ""} until ${hhmm(until)}`;

async function resolveSessionKey(session?: string): Promise<string> {
  if (session?.trim()) return session.trim();
  const name = await detectSessionName();
  if (!name) throw new CliError("no session name for this terminal", "pai now --session <name|id>");
  return name;
}

async function setCmd(ctx: RunContext): Promise<number> {
  if (process.env.PAI_WORKER === "1") {
    console.log("worker session: no window (only the operator's session opens one)");
    return 0;
  }
  const key = await resolveSessionKey(ctx.args.SESSION as string | undefined);
  const local = ctx.opts.local === true;
  const raw = ctx.opts.minutes;
  const minutes = raw === undefined ? windowMinutes() : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new CliError("--minutes must be a positive number", "pai now --minutes 30");
  recordUrgency([key], minutes, local);
  const u = readUrgencyFor(key)!;
  console.log(stateLine(key, u.until, u.where));
  return 0;
}

function statusCmd(ctx: RunContext): number {
  const session = ctx.args.SESSION as string | undefined;
  if (session?.trim()) {
    const u = readUrgencyFor(session.trim());
    console.log(u ? stateLine(session.trim(), u.until, u.where) : `no urgency window for ${session.trim()}`);
    return 0;
  }
  const mine = readUrgency();
  if (mine) {
    console.log(stateLine("this session", mine.until, mine.where));
    return 0;
  }
  const rows = listUrgency();
  console.log(rows.length ? rows.map((r) => stateLine(r.key, r.until, r.where)).join("\n") : "no urgency window open");
  return 0;
}

async function clearCmd(ctx: RunContext): Promise<number> {
  const session = ctx.args.SESSION as string | undefined;
  if (session?.trim()) {
    const removed = clearUrgency(process.env, session.trim());
    console.log(removed ? `urgency window for ${session.trim()} cleared` : `no urgency window for ${session.trim()}`);
    return 0;
  }
  const removed = clearUrgency(process.env);
  console.log(removed ? `urgency window cleared (${removed} file${removed > 1 ? "s" : ""})` : "no urgency window open for this session");
  return 0;
}

export const nowCommand: CommandDef = {
  name: "now",
  summary: "Urgency window: this session's workers run with now (front + preempt local)",
  description:
    "The operator's explicit instrumentation for urgency (the `/now` token in a prompt is the same switch). While a window is open, every worker this session starts runs with --now — ahead at the local engine, preempting the other local workers — and with where=local when it was opened with local. Workers already running when it opens are made urgent. `pai worker run --now` and `pai worker priority <id> now` are the per-worker forms. Workers never open a window themselves.",
  examples: ["pai now", "pai now --local --minutes 15", "pai worker run --local -p 'fix the flake'", "pai now --clear"],
  run: setCmd,
  seeAlso: ["pai worker ps", "pai worker priority"],
  subcommands: [
    {
      name: "set",
      summary: "Open (or extend) the window (default verb)",
      description: "Opens the window for this session, or for --session <name|id>. --local also forces where=local for those workers; --minutes N overrides the configured window (default 30). Prints one line: what is open until when.",
      args: [{ name: "SESSION", summary: "Session name or id (default: this session)" }],
      options: [
        { name: "local", type: "boolean", summary: "Those workers also run where=local" },
        { name: "minutes", type: "number", value: "N", summary: "Window length in minutes (default: workers.urgency.windowMinutes, 30)" },
      ],
      examples: ["pai now", "pai now --local", "pai now chat-7 --minutes 15"],
      run: setCmd,
    },
    {
      name: "status",
      summary: "Show the open window (this session, or all on this machine)",
      description: "With a session argument shows that session's window; otherwise this session's, and when none is open here, every open window on this machine.",
      args: [{ name: "SESSION", summary: "Session name or id" }],
      examples: ["pai now status", "pai now status chat-7"],
      run: statusCmd,
    },
    {
      name: "clear",
      summary: "Close the window now",
      description: "Closes this session's window (or --session's). Running workers keep their priority; change it with `pai worker priority <id> normal`.",
      args: [{ name: "SESSION", summary: "Session name or id (default: this session)" }],
      examples: ["pai now --clear", "pai now clear chat-7"],
      run: clearCmd,
    },
  ],
};
