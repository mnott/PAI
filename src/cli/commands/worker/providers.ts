/**
 * `pai worker providers` and `pai worker roles` — configuration commands.
 *
 * The actual mutations live in src/workers/providers.ts so the MCP tools run
 * the same code. The CLI only parses options (and deliberately accepts no
 * inline API keys — keys enter via --key-file; the MCP `add` tool is the one
 * place a raw key is accepted, and it parks it in ~/.config/pai/keys itself).
 */

import type { Command } from "commander";
import { WorkersConfigError, readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { testProvider } from "../../../workers/run.js";
import {
  addProvider,
  describeProviders,
  removeProvider,
  setProviderEnabled,
  setRole,
  unsetRole,
  useProvider,
} from "../../../workers/providers.js";
import { ok, err, dim } from "../../utils.js";

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(err("pai worker: ") + msg);
  process.exitCode = 1;
}

/** `--env K=V` (repeatable) → record. Throws on a value without "=". */
function collectEnv(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const eq = p.indexOf("=");
    if (eq <= 0) {
      throw new WorkersConfigError(`--env expects NAME=VALUE, got "${p}"`);
    }
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function parseIntArg(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new WorkersConfigError(`expected a positive number, got "${v}"`);
  }
  return n;
}

/** `glm/fast` | `{provider, mcp}` → one printable target line. */
function roleTargetText(target: unknown): string {
  if (typeof target === "string") return target;
  if (typeof target === "object" && target !== null) {
    const t = target as { provider?: string; mcp?: string[] };
    return `${t.provider ?? "?"}${t.mcp?.length ? ` +mcp(${t.mcp.join(",")})` : ""}`;
  }
  return String(target);
}

export function registerWorkerProviderCommands(providersCmd: Command): void {
  providersCmd
    .description("Providers: list (default), add, remove, use, enable, disable, test")
    .action(() => {
      const { workers } = readWorkersSection();
      console.log();
      for (const line of describeProviders(workers)) console.log(`  ${line}`);
      console.log();
      console.log(dim(`  workers are ${workers.enabled ? "on" : "off"} — pai worker ${workers.enabled ? "off" : "on"}`));
      console.log();
    });

  providersCmd
    .command("add <name>")
    .description(
      "Add a provider; the first one also turns workers on and seeds roles.\n" +
        "Example: pai worker providers add glm --base-url https://…/anthropic \\\n" +
        "           --key-file ~/.config/zai/api_key --model glm-5.3 --fast-model glm-5.3-flash\n" +
        "OpenAI-protocol: --protocol openai --upstream-url https://…/v1 (runs via the PAI proxy).\n" +
        "Codex (ChatGPT plan): --engine codex — runs through the Codex CLI."
    )
    .option("--base-url <url>", "Anthropic-compatible API base URL (required unless --protocol openai)")
    .requiredOption("--model <model>", "Default model id for this provider")
    .option("--key-file <path>", "File holding the API token (0600); omit for token \"local\"")
    .option("--fast-model <model>", "Cheaper model for spotchecks and routing")
    .option("--env <name=value>", "Extra env for runs (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--note <text>", "Human note shown in `providers list`")
    .option("--protocol <proto>", "anthropic (default) or openai — openai runs through the local PAI proxy")
    .option("--upstream-url <url>", "Chat Completions base URL (required for --protocol openai)")
    .option("--engine <engine>", "claude (default) or codex — codex runs `codex exec --json`")
    .option("--context-window <tokens>", "Context window for the meter (default 200000; init event overrides)", parseIntArg)
    .option("--quota-probe <url>", "URL whose JSON first number is the quota percent (0-100)")
    .action(
      (
        name: string,
        opts: {
          baseUrl?: string;
          model: string;
          keyFile?: string;
          fastModel?: string;
          env?: string[];
          note?: string;
          protocol?: string;
          upstreamUrl?: string;
          engine?: string;
          contextWindow?: number;
          quotaProbe?: string;
        }
      ) => {
        try {
          const protocol = opts.protocol as "anthropic" | "openai" | undefined;
          const engine = opts.engine as "claude" | "codex" | undefined;
          if (protocol && protocol !== "anthropic" && protocol !== "openai") {
            throw new WorkersConfigError(`--protocol must be anthropic or openai, got "${protocol}"`);
          }
          if (engine && engine !== "claude" && engine !== "codex") {
            throw new WorkersConfigError(`--engine must be claude or codex, got "${engine}"`);
          }
          if (protocol !== "openai" && !opts.baseUrl) {
            throw new WorkersConfigError("--base-url is required (only --protocol openai goes without it)");
          }
          addProvider({
            name,
            baseUrl: opts.baseUrl ?? "",
            keyFile: opts.keyFile ?? null,
            model: opts.model,
            fastModel: opts.fastModel,
            env: collectEnv(opts.env),
            note: opts.note,
            ...(protocol ? { protocol } : {}),
            ...(opts.upstreamUrl ? { upstreamUrl: opts.upstreamUrl } : {}),
            ...(engine ? { engine } : {}),
            ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
            quotaProbe: opts.quotaProbe,
          });
          const { workers } = readWorkersSection();
          console.log(ok(`provider ${name} added`));
          if (workers.active === name) console.log(`  active: ${name} — workers ${workers.enabled ? "on" : "off"}`);
          for (const line of describeProviders(workers)) console.log(dim(`  ${line}`));
        } catch (e) {
          fail(e);
        }
      }
    );

  providersCmd
    .command("remove <name>")
    .description("Remove a provider and any roles pointing at it")
    .action((name: string) => {
      try {
        removeProvider(name);
        console.log(ok(`provider ${name} removed`));
      } catch (e) {
        fail(e);
      }
    });

  providersCmd
    .command("use <name>")
    .description("Make this provider the active one for runs without --provider/--role")
    .action((name: string) => {
      try {
        useProvider(name);
        console.log(ok(`active provider: ${name}`));
      } catch (e) {
        fail(e);
      }
    });

  providersCmd
    .command("enable <name>")
    .description("Enable a provider (also clears its cooldown)")
    .action((name: string) => {
      try {
        setProviderEnabled(name, true);
        console.log(ok(`provider ${name} enabled`));
      } catch (e) {
        fail(e);
      }
    });

  providersCmd
    .command("disable <name>")
    .description("Disable a provider (auto-routing skips it; --provider still works)")
    .action((name: string) => {
      try {
        setProviderEnabled(name, false);
        console.log(ok(`provider ${name} disabled`));
      } catch (e) {
        fail(e);
      }
    });

  providersCmd
    .command("test [name]")
    .description("One-word pong probe through a provider (default: the active one)")
    .action(async (name: string | undefined) => {
      try {
        const { workers } = readWorkersSection();
        const pname = name ?? workers.active ?? "";
        if (!pname || !workers.providers[pname]) {
          throw new WorkersConfigError(
            name ? `no provider named "${name}"` : "no active provider — name one explicitly"
          );
        }
        console.log(dim(`  probing ${pname} (${workers.providers[pname].models.default}) …`));
        const r = await testProvider(pname, workers.providers[pname], workersLogDir(workers));
        const head = `${r.provider} ${r.model}  ${(r.latencyMs / 1000).toFixed(1)}s`;
        if (r.skipped) {
          // e.g. engine codex without the CLI installed: report, do not fail
          console.log(dim(`  ${head}  ${r.skipped}`));
          console.log(`  reply: ${r.result.slice(0, 200)}`);
          return;
        }
        console.log(r.ok ? ok(`  ${head}`) : err(`  ${head}`));
        console.log(`  reply: ${r.result.slice(0, 200)}`);
        process.exitCode = r.ok ? 0 : 1;
      } catch (e) {
        fail(e);
      }
    });

  // no roles here — they hang directly off `pai worker roles`
}

/** `pai worker roles` — role → provider[/fast] assignment. */
export function registerWorkerRoleCommands(workerCmd: Command): void {
  const rolesCmd = workerCmd
    .command("roles")
    .description("Roles: which provider serves implement / research / spotcheck")
    .action(() => {
      // bare `pai worker roles` behaves like `roles list`
      const { workers } = readWorkersSection();
      const entries = Object.entries(workers.roles);
      if (!entries.length) {
        console.log(dim("  no roles set — runs use the active provider"));
        return;
      }
      for (const [role, target] of entries) console.log(`  ${role.padEnd(12)} ${roleTargetText(target)}`);
    });

  rolesCmd
    .command("list")
    .description("List roles and their providers (default action)")
    .action(() => {
      const { workers } = readWorkersSection();
      const entries = Object.entries(workers.roles);
      if (!entries.length) {
        console.log(dim("  no roles set — runs use the active provider"));
        return;
      }
      for (const [role, target] of entries) console.log(`  ${role.padEnd(12)} ${roleTargetText(target)}`);
    });

  rolesCmd
    .command("set <role> <provider[/alias]>")
    .description("Point a role at a provider, optionally its fast model (e.g. glm/fast)")
    .action((role: string, target: string) => {
      try {
        setRole(role, target);
        console.log(ok(`role ${role} → ${target}`));
      } catch (e) {
        fail(e);
      }
    });

  rolesCmd
    .command("unset <role>")
    .description("Remove a role (runs then use the active provider)")
    .action((role: string) => {
      try {
        unsetRole(role);
        console.log(ok(`role ${role} removed`));
      } catch (e) {
        fail(e);
      }
    });
}
