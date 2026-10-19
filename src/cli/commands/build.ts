/**
 * `pai build`: the machine-wide build queue. Behaviour lives in src/builds;
 * this file declares names, flags and help.
 */

import { spawn } from "node:child_process";
import { renderBuildQueue, buildNext, buildsDir, listBuilds } from "../../builds/queue.js";
import { buildSlots } from "../../builds/config.js";
import { runBuild, watchTicket } from "../../builds/gate.js";
import { doctor } from "../../builds/doctor.js";
import { CliError, type CommandDef, type RunContext } from "../define.js";

const out = (s: string) => process.stdout.write(s + "\n");

function spawnWatcher(dir: string, id: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  const c = spawn(process.execPath, [...process.execArgv, entry, "build", "watch", dir, id], { detached: true, stdio: "ignore" });
  c.unref();
}

async function gate(ctx: RunContext): Promise<number> {
  if (!ctx.rest.length) throw new CliError("no command given", "pai build run -- <command...>");
  return runBuild({
    dir: buildsDir(),
    command: ctx.rest,
    full: ctx.opts.full === true,
    label: typeof ctx.opts.label === "string" ? ctx.opts.label : undefined,
    slots: buildSlots(),
    spawnWatcher,
    handleSignals: true,
  });
}

const runCmd: CommandDef = {
  name: "run",
  summary: "Run a build command under the machine-wide build queue",
  description:
    "Waits for a free build slot (builds.slots, default 1; FIFO across every session and worker on this computer), then runs the command at low CPU priority with its output logged. The whole process tree is killed when this command or its caller dies. " +
    "The command gets PAI_BUILD_MODE=delta (default) or full (--full); project build scripts read it to build incrementally. The gate does not decide how to build deltas. Use --full only for a release or when asked.",
  options: [
    { name: "full", type: "boolean", summary: "Full build (PAI_BUILD_MODE=full): releases only, or when asked" },
    { name: "label", type: "string", value: "TEXT", summary: "Name shown in the queue (default: the command)" },
  ],
  passthrough: true,
  examples: ["pai build run -- xcodebuild -scheme App build", "pai build run --full --label release -- tools/build.sh"],
  seeAlso: ["pai build queue", "pai build lock"],
  run: gate,
};

const lockCmd: CommandDef = {
  name: "lock",
  summary: "Same lock as `run`, for a project's door script to call",
  description:
    "A door script (registered in .pai/builds.yaml) wraps its real command in this: `pai build lock -- xcodebuild ...`. Same queue and lock as `pai build run`. Inside a `pai build run` it just runs the command, so doors can be nested without deadlock.",
  options: runCmd.options,
  passthrough: true,
  examples: ["pai build lock -- xcodebuild -scheme App test"],
  seeAlso: ["pai build run", "pai build doctor"],
  run: gate,
};

const queueCmd: CommandDef = {
  name: "queue",
  summary: "Show the running and waiting builds",
  description: "Lists the builds holding a slot and those waiting, in start order.",
  examples: ["pai build queue"],
  seeAlso: ["pai build next"],
  run: async () => {
    out(renderBuildQueue(await listBuilds(buildsDir()), buildSlots()));
  },
};

const nextCmd: CommandDef = {
  name: "next",
  summary: "Give a waiting build the next free slot",
  description: "Moves one waiting build to the front of the queue; a running build is never interrupted.",
  args: [{ name: "ID", summary: "Build id (or the label of a waiting build)", required: true }],
  examples: ["pai build next b-20261019183000-4242"],
  seeAlso: ["pai build queue"],
  run: async (ctx) => {
    try {
      const order = await buildNext(buildsDir(), String(ctx.args.ID));
      out(`waiting order: ${order.join(", ") || "-"}`);
    } catch (e) {
      throw new CliError((e as Error).message, "pai build queue");
    }
  },
};

const doctorCmd: CommandDef = {
  name: "doctor",
  summary: "Check the project's registered build doors",
  description: "Reads .pai/builds.yaml above the current directory and flags every door that is missing or never calls `pai build lock`, which would bypass the queue.",
  examples: ["pai build doctor"],
  run: (ctx) => {
    void ctx;
    const r = doctor(process.cwd());
    if (!r.root) return out("no .pai/builds.yaml here: no doors registered"), 0;
    for (const f of r.findings) out(`${f.ok ? "ok  " : "FAIL"} ${f.door}${f.problem ? ` — ${f.problem}` : ""}`);
    if (!r.findings.length) out("no doors registered");
    return r.findings.every((f) => f.ok) ? 0 : 1;
  },
};

const watchCmd: CommandDef = {
  name: "watch",
  summary: "Internal: kill a build tree when its gate process dies",
  description: "Started detached by `pai build run`.",
  args: [
    { name: "DIR", summary: "Builds directory", required: true },
    { name: "ID", summary: "Ticket id", required: true },
  ],
  hidden: true,
  examples: ["pai build watch DIR ID"],
  run: async (ctx) => {
    await watchTicket(String(ctx.args.DIR), String(ctx.args.ID));
  },
};

export const buildCommand: CommandDef = {
  name: "build",
  summary: "One machine-wide build queue: run, lock, queue, next, doctor",
  description:
    "Heavy builds (xcodebuild, simulator tests, swift/gradle/cargo build or test) run one at a time machine-wide, FIFO, at low priority, deltas by default. " +
    "Raw builders are denied in Bash by the PreToolUse guard unless they go through `pai build run` or a door registered in the project's .pai/builds.yaml (`doors: [tools/build.sh]`, `patterns: [...]`). See docs/builds.md.",
  examples: ["pai build run -- xcodebuild -scheme App build", "pai build queue"],
  subcommands: [runCmd, lockCmd, queueCmd, nextCmd, doctorCmd, watchCmd],
};
