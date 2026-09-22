/**
 * `pai worker providers` and `pai worker classes` — configuration commands.
 *
 * The actual mutations live in src/workers/providers.ts so the MCP tools run
 * the same code. The CLI only parses options. --key writes the token
 * verbatim as `key:` in workers.yaml (quoted, file kept 0600); --key-file
 * writes only a path. The MCP `add` tool takes a third route — a raw key it
 * parks in ~/.claude/pai/keys itself, storing only the path.
 *
 * `pai worker roles` stays as an alias of `classes` over the same data (the
 * config key was renamed; old configs migrate on first write).
 */

import type { Command } from "commander";
import {
  PROVIDER_TAGS,
  WorkersConfigError,
  readWorkersSection,
  type ClassTarget,
} from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { workersYamlLegacyNotice } from "../../../workers/workers-config.js";
import { testProvider } from "../../../workers/run.js";
import {
  addProvider,
  classTargetText,
  describeProviders,
  removeProvider,
  setClass,
  setProviderEnabled,
  unsetClass,
  updateProvider,
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

function parseCostTier(v: string): number {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new WorkersConfigError(`cost tier must be an integer 1 (cheapest) … 5 (most expensive), got "${v}"`);
  }
  return n;
}

/** `--tags a,b` (repeatable) → validated tag list. */
function collectTags(vals: string[] | undefined): string[] {
  const out: string[] = [];
  for (const v of vals ?? []) {
    for (const t of v.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!(PROVIDER_TAGS as readonly string[]).includes(t)) {
        throw new WorkersConfigError(`"${t}" is not a tag (from: ${PROVIDER_TAGS.join(", ")})`);
      }
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

interface ClassSetOpts {
  provider?: string;
  mcp?: string;
  maxCostTier?: number;
  requireTags?: string[];
  order?: string;
}

/** Positional target + constraint flags → a ClassTarget for setClass. */
function buildClassTarget(target: string | undefined, opts: ClassSetOpts): ClassTarget {
  const hasConstraints =
    opts.provider !== undefined ||
    opts.mcp !== undefined ||
    opts.maxCostTier !== undefined ||
    opts.requireTags !== undefined ||
    opts.order !== undefined;
  if (target !== undefined && !hasConstraints) return target;
  const obj: Exclude<ClassTarget, string> = {};
  if (target !== undefined) obj.provider = target.split("/")[0];
  if (opts.provider !== undefined) obj.provider = opts.provider;
  if (opts.mcp !== undefined) obj.mcp = opts.mcp.split(",").map((s) => s.trim()).filter(Boolean);
  if (opts.maxCostTier !== undefined) obj.maxCostTier = opts.maxCostTier;
  if (opts.requireTags !== undefined) obj.requireTags = opts.requireTags;
  if (opts.order !== undefined) obj.order = opts.order.split(",").map((s) => s.trim()).filter(Boolean);
  if (target !== undefined && target.includes("/") && obj.provider) {
    // provider/alias in string form only; keep it out of the object
    const alias = target.split("/")[1];
    if (alias && alias !== "default") {
      throw new WorkersConfigError(
        `a provider alias ("${alias}") cannot be combined with constraint flags — ` +
          `use the plain "<target>" form for pinning`
      );
    }
  }
  if (!Object.keys(obj).length) {
    throw new WorkersConfigError("give a target (provider, provider/fast) or a constraint (--max-cost-tier, --require-tags, …)");
  }
  return obj;
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
      const legacyNotice = workersYamlLegacyNotice();
      if (legacyNotice) console.log(dim(`  ${legacyNotice}`));
      console.log();
    });

  providersCmd
    .command("add <name>")
    .description(
      "Add a provider; the first one also turns workers on and seeds classes.\n" +
        "Example: pai worker providers add glm --url https://…/anthropic \\\n" +
        "           --key sk-… --model glm-5.3 --fast-model glm-5.3-flash\n" +
        "--key writes the token inline as `key:` in workers.yaml (quoted, file kept 0600);\n" +
        "--key-file writes only a path to a 0600 file holding it — use one or the other.\n" +
        "OpenAI-protocol: --protocol openai --upstream-url https://…/v1 (runs via the PAI proxy).\n" +
        "Codex (ChatGPT plan): --engine codex — runs through the Codex CLI.\n" +
        "Image generation: --engine image — `pai worker run --capability image` then POSTs\n" +
        "straight to {url}/images/generations instead of spawning claude."
    )
    .option("--base-url <url>", "Anthropic-compatible API base URL (required unless --protocol openai)")
    .option("--url <url>", "Alias of --base-url")
    .requiredOption("--model <model>", "Default model id for this provider")
    .option("--key <token>", "API token, written inline as `key:` (quoted); use instead of --key-file")
    .option("--key-file <path>", "File holding the API token (0600); omit for token \"local\"")
    .option("--fast-model <model>", "Cheaper model for spotchecks and routing")
    .option("--env <name=value>", "Extra env for runs (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--note <text>", "Human note shown in `providers list`")
    .option("--protocol <proto>", "anthropic (default) or openai — openai runs through the local PAI proxy")
    .option("--upstream-url <url>", "Chat Completions base URL (required for --protocol openai)")
    .option("--engine <engine>", "claude (default), codex, or image — codex runs `codex exec --json`, image POSTs {url}/images/generations")
    .option("--context-window <tokens>", "Context window for the meter (default 200000; init event overrides)", parseIntArg)
    .option("--quota-probe <url>", "URL whose JSON first number is the quota percent (0-100)")
    .option("--cost-tier <1-5>", "Cost tier 1 (cheapest) … 5 (most expensive; default 3)", parseCostTier)
    .option("--tags <tags>", "Capability tags, comma-separated (from: " + PROVIDER_TAGS.join(", ") + ")", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .action(
      (
        name: string,
        opts: {
          baseUrl?: string;
          url?: string;
          model: string;
          key?: string;
          keyFile?: string;
          fastModel?: string;
          env?: string[];
          note?: string;
          protocol?: string;
          upstreamUrl?: string;
          engine?: string;
          contextWindow?: number;
          quotaProbe?: string;
          costTier?: number;
          tags?: string[];
        }
      ) => {
        try {
          const protocol = opts.protocol as "anthropic" | "openai" | undefined;
          const engine = opts.engine as "claude" | "codex" | "image" | undefined;
          if (protocol && protocol !== "anthropic" && protocol !== "openai") {
            throw new WorkersConfigError(`--protocol must be anthropic or openai, got "${protocol}"`);
          }
          if (engine && engine !== "claude" && engine !== "codex" && engine !== "image") {
            throw new WorkersConfigError(`--engine must be claude, codex, or image, got "${engine}"`);
          }
          const baseUrl = opts.baseUrl ?? opts.url;
          if (protocol !== "openai" && !baseUrl) {
            throw new WorkersConfigError("--base-url (or --url) is required (only --protocol openai goes without it)");
          }
          if (opts.key && opts.keyFile) {
            throw new WorkersConfigError("--key and --key-file are alternatives — pass one, not both");
          }
          const tags = collectTags(opts.tags);
          addProvider({
            name,
            baseUrl: baseUrl ?? "",
            keyFile: opts.keyFile ?? null,
            ...(opts.key ? { inlineKey: opts.key } : {}),
            model: opts.model,
            fastModel: opts.fastModel,
            env: collectEnv(opts.env),
            note: opts.note,
            ...(protocol ? { protocol } : {}),
            ...(opts.upstreamUrl ? { upstreamUrl: opts.upstreamUrl } : {}),
            ...(engine ? { engine } : {}),
            ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
            quotaProbe: opts.quotaProbe,
            ...(opts.costTier !== undefined ? { costTier: opts.costTier } : {}),
            ...(tags.length ? { tags } : {}),
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
    .command("update <name>")
    .description("Change cost tier and tags of a provider (routing constraints use these)")
    .option("--cost-tier <1-5>", "Cost tier 1 (cheapest) … 5 (most expensive)", parseCostTier)
    .option("--tags <tags>", "Capability tags, comma-separated (from: " + PROVIDER_TAGS.join(", ") + "); --tags '' clears", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .action(
      (
        name: string,
        opts: { costTier?: number; tags?: string[] }
      ) => {
        try {
          if (opts.costTier === undefined && opts.tags === undefined) {
            throw new WorkersConfigError("nothing to update — pass --cost-tier and/or --tags");
          }
          const tags = opts.tags === undefined ? undefined : collectTags(opts.tags);
          updateProvider(name, {
            ...(opts.costTier !== undefined ? { costTier: opts.costTier } : {}),
            ...(tags !== undefined ? { tags } : {}),
          });
          console.log(ok(`provider ${name} updated`));
          const { workers } = readWorkersSection();
          for (const line of describeProviders(workers)) console.log(dim(`  ${line}`));
        } catch (e) {
          fail(e);
        }
      }
    );

  providersCmd
    .command("remove <name>")
    .description("Remove a provider and any classes pointing at it")
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
    .description("Make this provider the active one for runs without --provider/--class")
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
        const r = await testProvider(
          pname,
          workers.providers[pname],
          workersLogDir(workers),
          undefined,
          workers.caveman
        );
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

  // no classes here — they hang directly off `pai worker classes`
}

function printClasses(): void {
  const { workers } = readWorkersSection();
  const entries = Object.entries(workers.classes);
  if (!entries.length) {
    console.log(dim("  no classes set — runs use the active provider (or auto routing)"));
    return;
  }
  for (const [cls, target] of entries) console.log(`  ${cls.padEnd(12)} ${classTargetText(target)}`);
}

function registerClassSubcommands(classesCmd: Command): void {
  classesCmd
    .command("list")
    .description("List classes and their targets (default action)")
    .action(() => printClasses());

  classesCmd
    .command("set <class> [target]")
    .description(
      "Point a class at a provider (or provider/fast), or give only constraints:\n" +
        "classes set research --max-cost-tier 2 --require-tags long-context,reasoning"
    )
    .option("--provider <name>", "Pin the class to this provider (object form)")
    .option("--mcp <names>", "MCP servers/sets for runs of this class (comma-separated)")
    .option("--max-cost-tier <1-5>", "Auto-routing considers only providers up to this cost tier", parseCostTier)
    .option("--require-tags <tags>", "Auto-routing needs these tags (comma-separated)", (v: string) =>
      v.split(",").map((s) => s.trim()).filter(Boolean)
    )
    .option("--order <providers>", "Per-class routing order overriding workers.routing.order (comma-separated)")
    .action((cls: string, target: string | undefined, opts: ClassSetOpts) => {
      try {
        const built = buildClassTarget(target, opts);
        setClass(cls, built);
        console.log(ok(`class ${cls} → ${classTargetText(built)}`));
      } catch (e) {
        fail(e);
      }
    });

  classesCmd
    .command("unset <class>")
    .description("Remove a class (runs then use the active provider)")
    .action((cls: string) => {
      try {
        unsetClass(cls);
        console.log(ok(`class ${cls} removed`));
      } catch (e) {
        fail(e);
      }
    });
}

/** `pai worker classes` — class → target assignment (roles is the old name). */
export function registerWorkerClassCommands(workerCmd: Command): void {
  const classesCmd = workerCmd
    .command("classes")
    .description("Classes: which provider serves draft / implement / review / …")
    .action(() => printClasses());
  registerClassSubcommands(classesCmd);

  // `roles` — the pre-classes name; same data, kept for muscle memory
  const rolesCmd = workerCmd
    .command("roles", { hidden: true })
    .description("Alias of `classes` (roles was renamed to classes)")
    .action(() => printClasses());
  registerClassSubcommands(rolesCmd);
}
