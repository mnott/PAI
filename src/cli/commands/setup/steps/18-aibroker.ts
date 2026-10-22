/** Step 18: AIBroker, PAI's messaging layer (session messages, worker reports, tab names, WhatsApp/Telegram). */

import { spawnSync } from "node:child_process";
import { c, line, section, setupOptions } from "../utils.js";

export type AibrokerStatus = "ok" | "installed" | "skipped" | "failed";

export interface CmdResult { status: number | null; output: string }
export type CmdRunner = (cmd: string, args: string[]) => CmdResult;

/** Longest any one AIBroker command may run before it counts as failed. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;

/** `aibroker setup` may ask questions: give it the terminal when there is one and --yes is off. */
export const defaultRunner: CmdRunner = (cmd, args) => {
  const interactive = cmd === "aibroker" && args[0] === "setup" && !setupOptions.yes && !!process.stdin.isTTY;
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, ...(interactive ? { stdio: "inherit" as const } : {}) });
  return { status: r.error ? null : r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error.message) : ""}`.trim() };
};

/** The package the step installs; the range keeps a breaking major from arriving unannounced. */
export const AIBROKER_PACKAGE = "aibroker@^0.62.4";

/** `aibroker` is not on PATH: spawn error (null) or the shell's "not found". */
const isMissing = (r: CmdResult): boolean => r.status === null || r.status === 127;

/** The commands the step runs when AIBroker is missing or unhealthy, in order. */
export const AIBROKER_COMMANDS: ReadonlyArray<readonly [string, string[]]> = [
  ["npm", ["install", "-g", AIBROKER_PACKAGE]],
  ["aibroker", ["setup"]],
  ["aibroker", ["doctor"]],
];

const show = ([cmd, args]: readonly [string, string[]]) => [cmd, ...args].join(" ");

export function aibrokerPlan(): string[] {
  return AIBROKER_COMMANDS.map(show);
}

export function stepAibroker(
  run: CmdRunner = defaultRunner,
  opts: { skip?: boolean; dryRun?: boolean } = { skip: setupOptions.noAibroker, dryRun: setupOptions.dryRun },
): AibrokerStatus {
  section("Step 18: AIBroker (Messaging)");
  line();
  line("  AIBroker is PAI's messaging layer: session-to-session messages, worker reports,");
  line("  terminal tab names, WhatsApp/Telegram/PAILot. PAI works without it, minus messaging.");
  line();

  if (opts.skip) {
    console.log(c.dim("  Skipped (--no-aibroker). Install later: npm install -g aibroker@^0.62.4 && aibroker setup"));
    return "skipped";
  }
  if (opts.dryRun) {
    line("  Would run (if AIBroker is missing or `aibroker doctor` fails):");
    for (const p of aibrokerPlan()) line(`    ${p}`);
    return "skipped";
  }

  const present = run("aibroker", ["doctor"]);
  if (present.status === 0) {
    console.log(c.ok("AIBroker already installed and healthy."));
    return "ok";
  }

  // Install only when the binary is missing; an unhealthy install just gets `setup` and `doctor` again.
  const steps = isMissing(present) ? AIBROKER_COMMANDS : AIBROKER_COMMANDS.slice(1);
  for (const step of steps) {
    const r = run(step[0], step[1]);
    if (r.status !== 0) {
      console.log(c.warn(`  \`${show(step)}\` failed (exit ${r.status ?? "n/a"}).`));
      if (r.output) line(`    ${r.output.split("\n").join("\n    ")}`);
      console.log(c.warn(`  Retry with: ${aibrokerPlan().slice(AIBROKER_COMMANDS.indexOf(step)).join(" && ")}`));
      return "failed";
    }
    console.log(c.ok(`${show(step)}: ok`));
  }
  console.log(c.ok("AIBroker installed."));
  return "installed";
}
