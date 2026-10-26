/** `pai harness ...`: sessions PAI can read from agent harnesses (read-only). */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandDef, RunContext } from "../define.js";
import { ADAPTERS, enabledHarnessNames } from "../../harness/index.js";
import type { HarnessSession } from "../../harness/types.js";
import { applyOpenCodeSetup, planOpenCodeSetup } from "../../harness/opencode/setup.js";
import { packageRoot } from "../../module-paths.js";
import { CliError } from "../define.js";
import { maskSecrets } from "../../hooks/ts/lib/loop-guard.js";
import { dim, ok, renderTable, shortenPath } from "../lib/utils.js";

const fmt = (iso: string): string => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "—");

function sessionsFor(harness: string, cwd?: string): HarnessSession[] {
  const a = ADAPTERS.find((x) => x.name === harness);
  if (!a || !a.detect()) return [];
  return a.listSessions(cwd ? { cwd } : undefined);
}

function listCmd(opts: { json?: boolean }): number {
  const enabled = new Set(enabledHarnessNames());
  const rows = ADAPTERS.map((a) => {
    const detected = a.detect();
    return [
      a.name,
      detected ? ok("yes") : dim("no"),
      enabled.has(a.name) ? ok("yes") : dim("no"),
      detected ? String(sessionsFor(a.name).length) : dim("—"),
    ];
  });
  if (opts.json) {
    console.log(
      JSON.stringify(
        ADAPTERS.map((a) => ({
          adapter: a.name,
          detected: a.detect(),
          enabled: enabled.has(a.name),
          sessions: a.detect() ? sessionsFor(a.name).length : undefined,
        })),
        null,
        2
      )
    );
    return 0;
  }
  console.log(renderTable(["adapter", "detected", "enabled", "sessions"], rows));
  console.log(dim(`  enabled set comes from config key harness.adapters (pai config get harness.adapters)`));
  return 0;
}

function sessionsCmd(opts: { harness?: string; cwd?: string; json?: boolean }): number {
  const names = opts.harness ? [opts.harness] : enabledHarnessNames();
  const out: HarnessSession[] = [];
  for (const name of names) out.push(...sessionsFor(name, opts.cwd));
  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  if (!out.length) {
    console.log(dim(`  no sessions${opts.cwd ? ` under ${opts.cwd}` : ""} (${names.join(", ")})`));
    return 0;
  }
  console.log(
    renderTable(
      ["harness", "id", "updated", "cwd"],
      out.map((s) => [s.harness, s.id, fmt(s.updatedAt), s.cwd ? maskSecrets(shortenPath(s.cwd, 48)) : dim("—")])
    )
  );
  return 0;
}

function setupCmd(harness: string, opts: RunContext["opts"]): number {
  if (harness !== "opencode") throw new CliError(`no setup for harness "${harness}"`, "pai harness setup opencode");
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  const configDir = (opts["config-dir"] as string | undefined) ?? join(xdg || join(home, ".config"), "opencode");
  const provider = opts.provider as string | undefined;
  const model = opts.model as string | undefined;
  if (!!provider !== !!model) throw new CliError("--provider and --model go together", "pai harness setup opencode --provider glm --model glm-5");
  const plan = planOpenCodeSetup({
    home,
    configDir,
    packageRoot: packageRoot(import.meta.url),
    allMcp: opts["all-mcp"] === true,
    ...(provider && model && { routerProvider: { name: provider, model } }),
  });
  const write = opts.write === true;
  console.log(`  OpenCode config dir: ${shortenPath(configDir, 60)}`);
  for (const f of plan.files) {
    const state = f.before === null ? "new" : f.before === f.content ? "unchanged" : "changed";
    console.log(`  ${write ? "write" : "would write"} ${shortenPath(f.path, 70)} (${state})`);
  }
  console.log(`  MCP servers: ${plan.mcpServers.join(", ")}`);
  console.log(`  commands (${plan.commands.length}): ${plan.commands.join(", ") || "none"}`);
  console.log(`  skills OpenCode reads from ~/.claude/skills (${plan.skills.length}): ${plan.skills.join(", ") || "none"}`);
  console.log(`  guards: ${plan.hooks.map((h) => `${h.hook} -> ${h.tools.join("/")}`).join(", ") || "none"}`);
  if (plan.envRefs.length) console.log(`  needs these env vars exported before opencode starts: ${plan.envRefs.join(", ")}`);
  for (const w of plan.warnings) console.log(dim(`  ! ${w}`));
  if (!write) {
    console.log(dim("  dry run: nothing written. Add --write to apply (changed files are backed up as <file>.bak-<stamp>)."));
    return 0;
  }
  const done = applyOpenCodeSetup(plan);
  for (const b of done.backups) console.log(dim(`  backup ${shortenPath(b, 70)}`));
  console.log(ok(`  wrote ${done.written.length} file(s). Start OpenCode and ask it for pai_worker_ps.`));
  return 0;
}

export const harnessCommand: CommandDef = {
  name: "harness",
  summary: "Sessions PAI can read from agent harnesses (Claude Code, Codex, ...)",
  description:
    "Read-only ingestion of other harnesses' session logs. `list` shows each adapter: detected (its store exists), enabled (config key harness.adapters), and its session count. `sessions` lists the sessions themselves.",
  examples: ["pai harness list", "pai harness sessions", "pai harness sessions --harness codex --cwd ~/proj"],
  seeAlso: ["pai config get harness.adapters"],
  subcommands: [
    {
      name: "list",
      summary: "Each adapter: detected, enabled, session count",
      description: "One row per adapter PAI knows. Only enabled adapters whose store exists are ever read.",
      options: [{ name: "json", type: "boolean", default: false, summary: "Print JSON instead of a table" }],
      examples: ["pai harness list", "pai harness list --json"],
      run: (ctx: RunContext) => listCmd({ json: ctx.opts.json === true }),
    },
    {
      name: "sessions",
      summary: "List sessions, newest first",
      description: "Sessions of the enabled adapters (or one harness with --harness), optionally limited to one working directory.",
      options: [
        { name: "harness", type: "string", value: "NAME", summary: "Only this adapter (default: the enabled set)" },
        { name: "cwd", type: "string", value: "DIR", summary: "Only sessions of this working directory" },
        { name: "json", type: "boolean", default: false, summary: "Print JSON instead of a table" },
      ],
      examples: ["pai harness sessions", "pai harness sessions --harness codex", "pai harness sessions --cwd ~/proj"],
      run: (ctx: RunContext) => {
        const cwd = ctx.opts.cwd as string | undefined;
        if (cwd && !existsSync(cwd)) {
          console.log(dim(`  no such directory: ${cwd}`));
          return 0;
        }
        return sessionsCmd({ harness: ctx.opts.harness as string | undefined, cwd, json: ctx.opts.json === true });
      },
    },
    {
      name: "setup",
      summary: "Make a harness a PAI frontend (opencode)",
      description:
        "Writes the OpenCode config that registers PAI's MCP server (as Claude Code has it), points OpenCode at PAI's instructions (rendered for OpenCode from the one source), exposes your Claude Code commands, and installs the bridge plugin that applies PAI's delegation and security guards. Dry run unless --write; changed files are backed up first. Never touches opencode.jsonc.",
      args: [{ name: "HARNESS", required: true, summary: "opencode" }],
      options: [
        { name: "write", type: "boolean", default: false, summary: "Apply the plan (default: show it)" },
        { name: "config-dir", type: "string", value: "DIR", summary: "OpenCode config dir (default: $XDG_CONFIG_HOME/opencode or ~/.config/opencode)" },
        { name: "all-mcp", type: "boolean", default: false, summary: "Register every Claude Code MCP server, not only pai" },
        { name: "provider", type: "string", value: "NAME", summary: "Run OpenCode's own model through the PAI router on this provider" },
        { name: "model", type: "string", value: "MODEL", summary: "Model for --provider" },
      ],
      examples: ["pai harness setup opencode", "pai harness setup opencode --write", "pai harness setup opencode --write --provider glm --model glm-5"],
      run: (ctx: RunContext) => setupCmd(String(ctx.args.HARNESS), ctx.opts),
    },
  ],
};
