  const raw = readConfigRaw();/**
 * Every question the wizard asks, as data: key, flag, default, allowed values and,
 * where the machine already holds an answer, the current value. `pai setup --questions`
 * prints it so a caller without a TTY (the setup skill) can ask in chat and then run
 * `pai setup --yes <flags>`.
 */

import { loadConfig } from "../../../daemon/config.js";
import { readConfigRaw } from "./utils.js";

export interface SetupQuestion {
  id: string;
  step: string;
  question: string;
  type: "choice" | "bool" | "port" | "string";
  flag: string;
  default: string | number | boolean | null;
  allowed?: string[];
  /** Value already in place on this machine; the wizard skips (or keeps) it. */
  current?: string | number | boolean;
  /** Where the effective default differs from `default`, or no current value can be shown. */
  note?: string;
}

/** yes/no components: key = setupOptions.answers key, flag form depends on the default. */
export const COMPONENTS: ReadonlyArray<{ key: string; step: string; question: string; default: boolean }> = [
  { key: "claude-md", step: "Agent configuration", question: "Write ~/.claude/CLAUDE.md from the PAI template?", default: true },
  { key: "skill", step: "PAI skill", question: "Install the PAI skill?", default: true },
  { key: "steering-rules", step: "Steering rules", question: "Install the AI steering rules?", default: true },
  { key: "skill-stubs", step: "Skill stubs", question: "Symlink the PAI skill stubs into ~/.claude/skills/?", default: true },
  { key: "hooks", step: "Hooks", question: "Install the lifecycle hooks (session stop, pre-compact, statusline)?", default: true },
  { key: "ts-hooks", step: "TypeScript hooks", question: "Install the TypeScript hooks to ~/.claude/Hooks/?", default: true },
  { key: "settings", step: "Settings", question: "Patch ~/.claude/settings.json with PAI hooks, env vars and settings?", default: true },
  { key: "daemon", step: "Daemon", question: "Install the daemon as a login service?", default: true },
  { key: "mcp", step: "MCP", question: "Register the PAI MCP server in ~/.claude.json?", default: true },
  { key: "registry-scan", step: "Directories", question: "Run `pai registry scan` after setup?", default: false },
  { key: "task-bus", step: "Task bus", question: "Enable the task bus (needs a Todoist account)?", default: false },
  { key: "workers", step: "Workers", question: "Turn workers on with the built-in anthropic provider?", default: true },
];

/** Components whose answer is not a plain default. */
const COMPONENT_NOTES: Record<string, string> = {
  "registry-scan": "Off by default: scanning walks your project directories.",
  "task-bus": "Off by default. Needs a Todoist token in the config; with --yes the token cannot be asked, so set it first.",
};

export const componentFlag = (key: string, def: boolean): string => (def ? `--no-${key}` : `--${key}`);

export function setupQuestions(): SetupQuestion[] {
  const raw = readConfigRaw();
  const router = loadConfig().router;
  const rawRouter = (raw.router ?? {}) as Record<string, unknown>;
  const q: SetupQuestion[] = [];
  const cur = <T>(v: T | undefined | null) => (v === undefined || v === null || v === "" ? {} : { current: v });

  q.push({
    id: "storage", step: "Storage", question: "Where should PAI store its data?", type: "choice",
    flag: "--storage", default: "sqlite", allowed: ["sqlite", "postgres"], ...cur(raw.storageBackend as string | undefined),
    note: "With --yes and no --storage: postgres when a local PostgreSQL answers, else sqlite.",
  });
  q.push({
    id: "pg-url", step: "Storage", question: "PostgreSQL connection string (only when storage is postgres; default: the PAI Docker container)", type: "string",
    flag: "--pg-url", default: null, ...cur(((raw.postgres ?? {}) as Record<string, unknown>).connectionString as string | undefined),
  });
  q.push({
    id: "embedding", step: "Embedding", question: "Which embedding model for semantic search?", type: "choice",
    flag: "--embedding", default: "snowflake", allowed: ["snowflake", "bge", "nomic", "ollama", "none"], ...cur(raw.embeddingModel as string | undefined),
  });
  const component = (comp: (typeof COMPONENTS)[number]) => {
    const note = COMPONENT_NOTES[comp.key];
    q.push({ id: comp.key, step: comp.step, question: comp.question, type: "bool", flag: componentFlag(comp.key, comp.default), default: comp.default, ...(note ? { note } : {}) });
  };
  const routerQuestions = () => {
    q.push({
      id: "router", step: "Router and cockpit", question: "Enable the router and cockpit?", type: "bool",
      flag: "--router / --no-router", default: true, ...cur(typeof rawRouter.enabled === "boolean" ? rawRouter.enabled : undefined),
      note: "Setup defaults to on; the daemon's own default (key absent) is off. A re-run with router.enabled absent turns it on unless --no-router is given.",
    });
    q.push({
      id: "router-port", step: "Router and cockpit", question: "Port for the cockpit?", type: "port",
      flag: "--router-port", default: router.port, ...cur(rawRouter.port as number | undefined),
    });
    q.push({
      id: "router-bind", step: "Router and cockpit", question: "Who can reach the cockpit? Beyond loopback it is reachable from other devices.", type: "choice",
      flag: "--router-bind", default: "loopback", allowed: ["loopback", "tailscale", "<ipv4 address>"], ...cur(rawRouter.bind as string | undefined),
    });
  };
  const daName = () => q.push({ id: "da-name", step: "Settings", question: "What should your assistant be called?", type: "string", flag: "--da-name", default: "PAI" });
  const aibroker = () => q.push({ id: "aibroker", step: "AIBroker", question: "Install AIBroker (messaging)?", type: "bool", flag: "--no-aibroker", default: true });
  // Wizard order: the name precedes settings; router and AIBroker sit between the daemon and MCP.
  for (const comp of COMPONENTS) {
    if (comp.key === "settings") daName();
    component(comp);
    if (comp.key === "daemon") { routerQuestions(); aibroker(); }
  }
  return q;
}

export function renderQuestions(qs: SetupQuestion[]): string {
  return qs
    .map((x, i) => {
      const parts = [`${i + 1}. [${x.step}] ${x.question}`, `   flag: ${x.flag}  default: ${x.default ?? "(none)"}`];
      if (x.allowed) parts.push(`   allowed: ${x.allowed.join(" | ")}`);
      if (x.current !== undefined) parts.push(`   current: ${x.current} (already set)`);
      if (x.note) parts.push(`   note: ${x.note}`);
      return parts.join("\n");
    })
    .join("\n");
}
