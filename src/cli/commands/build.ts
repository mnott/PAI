/**
 * `pai build`: the machine-wide build queue. Behaviour lives in src/builds;
 * this file declares names, flags and help.
 */

import { spawn } from "node:child_process";
import { renderBuildQueue, buildNext, buildsDir, listBuilds } from "../../builds/queue.js";
import { slotsFor, poolSlots } from "../../builds/config.js";
import { beginBuildWait, endBuildWait } from "../../workers/active-time.js";
import { workersLogDir } from "../../workers/paths.js";
import { readWorkersSection } from "../../workers/config.js";
import { runBuild, watchTicket } from "../../builds/gate.js";
import { doctor, hookEventFindings } from "../../builds/doctor.js";
import { isCi } from "../../utils/ci.js";
import { checkNpmAuth, publishablePackage } from "../../builds/npm-auth.js";
import { formatMirror, syncMirrors, MirrorSyncFailed } from "../../builds/mirror-sync.js";
import { fmtSeenLocal } from "../../utils/fmt-age.js";
import { inVisiblePane } from "../../workers/pane.js";
import { runCommandInPane } from "./pane.js";
import { CliError, type CommandDef, type RunContext } from "../define.js";

const out = (s: string) => process.stdout.write(s + "\n");

function spawnWatcher(dir: string, id: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  const c = spawn(process.execPath, [...process.execArgv, entry, "build", "watch", dir, id], { detached: true, stdio: "ignore" });
  c.unref();
}

/** Inside a worker, record build-gate waits so its deadline counts active time only (active-time.ts). */
function workerWaitSink(): ((waiting: boolean) => void) | undefined {
  const id = process.env.PAI_WORKER_ID;
  if (!id) return undefined;
  let logDir: string;
  try {
    logDir = workersLogDir(readWorkersSection().workers);
  } catch {
    return undefined;
  }
  return (waiting) => (waiting ? beginBuildWait(logDir, id) : endBuildWait(logDir, id));
}

async function gate(ctx: RunContext): Promise<number> {
  if (!ctx.rest.length) throw new CliError("no command given", "pai build run -- <command...>");
  // from a session, the whole queue wait + build shows in a pane; a worker or an enclosing pane run already has one
  if (!inVisiblePane() && !process.env.PAI_BUILD_TICKET) {
    const label = typeof ctx.opts.label === "string" ? ctx.opts.label : `build ${ctx.rest.slice(0, 2).join(" ")}`;
    return runCommandInPane([process.execPath, ...process.execArgv, process.argv[1] ?? "pai", ...process.argv.slice(2)], label);
  }
  const kind = ctx.opts.kind === undefined ? "build" : ctx.opts.kind;
  if (kind !== "build" && kind !== "test") throw new CliError(`unknown kind "${String(kind)}"`, "pai build run --kind build|test -- <command...>");
  return runBuild({
    dir: buildsDir(),
    kind,
    command: ctx.rest,
    full: ctx.opts.full === true,
    label: typeof ctx.opts.label === "string" ? ctx.opts.label : undefined,
    key: typeof ctx.opts.key === "string" ? ctx.opts.key : undefined,
    slots: slotsFor(kind),
    spawnWatcher,
    handleSignals: true,
    onWait: workerWaitSink(),
  });
}

const runCmd: CommandDef = {
  name: "run",
  summary: "Run a build command under the machine-wide build queue",
  description:
    "Waits for a free build slot (builds.slots, default 1; FIFO across every session and worker on this computer), then runs the command at low CPU priority with its output logged. The whole process tree is killed when this command or its caller dies. " +
    "The command gets PAI_BUILD_MODE=delta (default) or full (--full); project build scripts read it to build incrementally. The gate does not decide how to build deltas. Use --full only for a release or when asked. " +
    "Jobs with the same --key (default: derived from a door script + its last argument, or xcodebuild -scheme) run one at a time so one target keeps one warm build tree; different keys overlap up to the slot limit. The command gets PAI_BUILD_JOBS (max(2, cores / slots)) to pass as -jobs. " +
    "Simulator/device test runs use --kind test: their own pool (builds.testSlots, default 2), and the simulators the job booted are shut down when it ends.",
  options: [
    { name: "full", type: "boolean", summary: "Full build (PAI_BUILD_MODE=full): releases only, or when asked" },
    { name: "label", type: "string", value: "TEXT", summary: "Name shown in the queue (default: the command)" },
    { name: "key", type: "string", value: "NAME", summary: "Build key (or PAI_BUILD_KEY): same-key jobs run one at a time, e.g. myapp-mac" },
    { name: "kind", type: "string", value: "build|test", summary: "Slot pool: build (default) or test for simulator/device test runs" },
  ],
  passthrough: true,
  examples: ["pai build run -- xcodebuild -scheme App build", "pai build run --kind test -- xcodebuild -scheme App test", "pai build run --full --label release -- tools/build.sh"],
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
  summary: "Show the running and waiting builds and tests",
  description: "Lists, per pool (builds, tests), the jobs holding a slot and those waiting, in start order.",
  examples: ["pai build queue"],
  seeAlso: ["pai build next"],
  run: async () => {
    out(renderBuildQueue(await listBuilds(buildsDir()), poolSlots()));
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
  summary: "Check the project's registered build doors and hook events",
  description: "Reads .pai/builds.yaml above the current directory and flags every door that is missing or never calls `pai build lock`, which would bypass the queue. Also prints one line per hook event: observed (a capture proves it ran), configured-but-never-observed (warning — the hook may silently not be running), or a configured hook whose script no longer exists (Stop: script missing — the hook never runs).",
  examples: ["pai build doctor"],
  run: async (ctx) => {
    void ctx;
    const r = doctor(process.cwd());
    if (!r.root) out("no .pai/builds.yaml here: no doors registered");
    else {
      for (const f of r.findings) out(`${f.ok ? "ok  " : "FAIL"} ${f.door}${f.problem ? ` — ${f.problem}` : ""}`);
      if (!r.findings.length) out("no doors registered");
    }
    const sinceHours = 24;
    let missingScripts = 0;
    for (const h of await hookEventFindings(process.cwd(), { sinceHours })) {
      if (h.missingScript) {
        missingScripts++;
        out(`Stop: script missing: ${h.missingScript}`);
      } else if (h.observed) out(`ok   ${h.event}: observed ${h.lastSeen ? fmtSeenLocal(h.lastSeen) : ""}`.trimEnd());
      else if (h.configured) out(`WARN ${h.event}: configured, never observed in ${sinceHours}h`);
    }
    const pkg = publishablePackage(process.cwd());
    let authRejected = false;
    if (pkg) {
      const a = checkNpmAuth(pkg.name);
      if (a.state === "ok") out(`npm publish auth: ok (${a.user})`);
      else if (a.state === "rejected") {
        authRejected = true;
        out("npm publish auth: REJECTED — see the renewal steps");
        out(a.message);
      } else out(`npm publish auth: unknown (${a.detail})`);
    }
    return r.findings.every((f) => f.ok) && missingScripts === 0 && !authRejected ? 0 : 1;
  },
};

const npmAuthCmd: CommandDef = {
  name: "npm-auth",
  summary: "Check the npm publish credential before `npm publish`",
  description: "Runs `npm whoami` against the public registry (10 s timeout). Exits 1 with the token renewal steps when npm rejects the credential; a timeout or network error is reported but does not fail. Used by prepublishOnly. A no-op when CI=true or GITHUB_ACTIONS=true (trusted publishing needs no token).",
  examples: ["pai build npm-auth"],
  seeAlso: ["pai build doctor"],
  run: async () => {
    if (isCi()) {
      out("npm publish auth: skipped (CI; trusted publishing)");
      return 0;
    }
    const a = checkNpmAuth(publishablePackage(process.cwd())?.name);
    if (a.state === "rejected") {
      process.stderr.write(a.message + "\n");
      return 1;
    }
    out(a.state === "ok" ? `npm publish auth: ok (${a.user})` : `npm publish auth: unknown (${a.detail})`);
    return 0;
  },
};

const mirrorSyncCmd: CommandDef = {
  name: "mirror-sync",
  summary: "Trigger the forge's push mirror to GitHub and report each mirror",
  description:
    "For forge-first repos (origin = a Gitea/Forgejo forge, a push mirror to GitHub): POSTs push_mirrors-sync, then polls push_mirrors (60 s, every 3 s) until each mirror's last_update changes, and prints one line per mirror. " +
    "A GitHub push-protection refusal (GH013) comes out as the short reason plus the unblock URL. Exits 0 when every mirror is ok. " +
    "Token: the env var named by config release.forgeTokenEnv (default AIBROKER_FORGE_TOKEN); never printed.",
  options: [
    { name: "repo", type: "string", value: "DIR", summary: "Repo directory (default: this directory)" },
    { name: "json", type: "boolean", summary: "Print the parsed result as JSON" },
  ],
  examples: ["pai build mirror-sync", "pai build mirror-sync --repo ~/code/app --json"],
  seeAlso: ["pai build npm-auth"],
  run: async (ctx) => {
    const dir = typeof ctx.opts.repo === "string" ? ctx.opts.repo : process.cwd();
    try {
      const r = await syncMirrors(dir);
      if (ctx.opts.json === true) out(JSON.stringify(r));
      else for (const m of r.mirrors) out(formatMirror(m));
      return r.mirrors.length && r.mirrors.every((m) => m.ok) ? 0 : 1;
    } catch (e) {
      if (e instanceof MirrorSyncFailed) throw new CliError(e.message, "pai build mirror-sync");
      throw e instanceof Error ? e : new Error(String(e));
    }
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
  summary: "One machine-wide build queue: run, lock, queue, next, doctor, npm-auth, mirror-sync",
  description:
    "Heavy builds (xcodebuild, swift/gradle/cargo build or test) run machine-wide through builds.slots slots, simulator/device test runs through their own builds.testSlots slots, FIFO, at low priority, deltas by default. " +
    "Raw builders are denied in Bash by the PreToolUse guard unless they go through `pai build run` or a door registered in the project's .pai/builds.yaml (`doors: [tools/build.sh]`, `patterns: [...]`). See docs/builds.md.",
  examples: ["pai build run -- xcodebuild -scheme App build", "pai build queue"],
  subcommands: [runCmd, lockCmd, queueCmd, nextCmd, doctorCmd, npmAuthCmd, mirrorSyncCmd, watchCmd],
};
