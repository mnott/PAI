/** `pai setup`: the first-time setup wizard (steps live in ./setup/). */

import chalk from "chalk";
import type { CommandDef, OptDef } from "../define.js";
import { legacy } from "../lib/legacy.js";
import { runSetup } from "./setup/index.js";
import { validBind, validPort } from "./setup/steps/19-router.js";
import { setupOptions } from "./setup/utils.js";
import { COMPONENTS, componentFlag, renderQuestions, setupQuestions } from "./setup/questions.js";

/** One flag per yes/no component: --no-<name> for default-yes ones, --<name> for default-no ones. */
const componentOptions: OptDef[] = COMPONENTS.map((comp) => ({
  name: componentFlag(comp.key, comp.default).slice(2),
  type: "boolean",
  default: false,
  summary: `${comp.default ? "Skip" : "Do"}: ${comp.question}`,
}));

export const setupCommand: CommandDef = {
  name: "setup",
  summary: "First-time setup: storage, search, hooks, daemon, router",
  description:
    "Walks through everything PAI needs: where data is stored, search embeddings, Claude Code hooks and settings, the background daemon, the router and cockpit (port, reach), AIBroker (messaging; installed automatically) and the first index.\n" +
    "Safe to run again. With --yes it takes every default and asks nothing; every question has a flag, so `pai setup --yes <flags>` can express any answer. `pai setup --questions [--json]` lists the questions with their flags, defaults and current values (for callers without a terminal).",
  options: [
    { name: "yes", short: "y", type: "boolean", default: false, summary: "Take every default (or the flag given) and read no input" },
    { name: "questions", type: "boolean", default: false, summary: "Print every question with its flag, default and allowed values; change nothing" },
    { name: "json", type: "boolean", default: false, summary: "With --questions: machine-readable JSON" },
    { name: "storage", type: "string", value: "BACKEND", summary: "Where to store data: sqlite or postgres (with --yes: sqlite unless a local Postgres answers)" },
    { name: "pg-url", type: "string", value: "URL", summary: "PostgreSQL connection string (implies --storage postgres)" },
    { name: "embedding", type: "string", value: "MODEL", summary: "Embeddings: snowflake, bge, nomic, ollama (Arctic on Ollama) or none" },
    { name: "da-name", type: "string", value: "NAME", summary: "What the assistant is called (default PAI)" },
    { name: "router", type: "boolean", summary: "Enable the router and cockpit (default)" },
    { name: "no-router", type: "boolean", summary: "Do not enable the router and cockpit" },
    { name: "router-port", type: "number", value: "PORT", summary: "Cockpit port (default: config router.port, 8790)" },
    { name: "router-bind", type: "string", value: "SCOPE", summary: "Who reaches the cockpit: loopback (default), tailscale or an IPv4 address" },
    { name: "no-aibroker", type: "boolean", default: false, summary: "Do not install AIBroker (the messaging layer)" },
    ...componentOptions,
    { name: "dry-run", type: "boolean", default: false, summary: "Validate the flags, print the AIBroker install commands and change nothing (other steps are not previewed)" },
  ],
  examples: [
    "pai setup",
    "pai setup --yes --storage sqlite",
    "pai setup --questions --json",
    "pai setup --yes --storage sqlite --embedding none --router-port 9000 --router-bind tailscale --no-hooks",
  ],
  seeAlso: ["pai update", "pai daemon status"],
  run(c) {
    return legacy(async () => {
      if (c.opts.questions === true) {
        const qs = setupQuestions();
        console.log(c.opts.json === true ? JSON.stringify(qs, null, 2) : renderQuestions(qs));
        return;
      }
      try {
        applySetupFlags(c.opts);
        await runSetup();
      } catch (e) {
        console.error(chalk.red(`pai setup: ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
      }
    });
  },
};

/** Validates the flags and copies them into setupOptions (throws naming the flag). */
export function applySetupFlags(opts: Record<string, unknown>): void {
  const storage = opts.storage as string | undefined;
  if (storage && storage !== "sqlite" && storage !== "postgres") throw new Error(`--storage must be sqlite or postgres, got "${storage}"`);
  const embedding = opts.embedding as string | undefined;
  if (embedding && !["snowflake", "bge", "nomic", "ollama", "none"].includes(embedding)) {
    throw new Error(`--embedding must be snowflake, bge, nomic, ollama or none, got "${embedding}"`);
  }
  const port = opts["router-port"];
  if (port !== undefined && validPort(port) === null) throw new Error(`--router-port must be a number from 1024 to 65535, got "${port}"`);
  const bind = opts["router-bind"];
  if (bind !== undefined && validBind(String(bind)) === null) {
    throw new Error(`--router-bind must be loopback, tailscale or an IPv4 address (not 0.0.0.0), got "${bind}"`);
  }
  if (opts.router === true && opts["no-router"] === true) throw new Error("--router and --no-router contradict each other");
  const answers: Record<string, boolean> = {};
  for (const comp of COMPONENTS) {
    if (opts[componentFlag(comp.key, comp.default).slice(2)] === true) answers[comp.key] = !comp.default;
  }
  setupOptions.yes = opts.yes === true;
  setupOptions.noAibroker = opts["no-aibroker"] === true;
  setupOptions.dryRun = opts["dry-run"] === true;
  setupOptions.storage = storage as "sqlite" | "postgres" | undefined;
  setupOptions.pgUrl = opts["pg-url"] as string | undefined;
  setupOptions.embedding = embedding;
  setupOptions.daName = opts["da-name"] as string | undefined;
  setupOptions.router = {
    enabled: opts["no-router"] === true ? false : opts.router === true ? true : undefined,
    port: opts["router-port"] as number | undefined,
    bind: opts["router-bind"] as string | undefined,
  };
  setupOptions.answers = answers;
}

export const installAlias: CommandDef = { ...setupCommand, name: "install", aliasOf: "setup" };
