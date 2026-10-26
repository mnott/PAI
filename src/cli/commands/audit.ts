/** `pai audit ...`: where tokens (and money) go. */

import { writeFileSync } from "node:fs";
import { exportAudit } from "../../tenants/audit-export.js";
import { CliError, OPT, type ArgDef, type CommandDef, type OptDef, type RunContext } from "../define.js";
import { auditFilesCmd, auditHooksCmd, auditSessionCmd, auditSpawnCmd, auditDaemonCmd, auditEnvCmd, auditScheduleCmd, auditSkillsCmd, auditSubagentsCmd, auditMcpCmd, auditLadderCmd, auditTokensCmd, auditScanCmd } from "../lib/audit.js";
import { priceTableText, renderUsage, transcriptUsage, usageJson } from "../../workers/usage.js";

const json: OptDef = { ...OPT.json, summary: "Print JSON instead of a table" };
const a = (def: Omit<CommandDef, "run">, run: (ctx: RunContext) => Promise<number> | number) =>
  // `--json` is read from the `tokens` node by the implementation; it is added to every report command here.
  ({ ...def, options: [...(def.options ?? []), json], run });

const t = (name: string, summary: string, description: string, extra: Partial<CommandDef> = {}) =>
  a({ name, summary, description, examples: [`pai audit tokens ${name}`, `pai audit tokens ${name} --json`], seeAlso: ["pai audit tokens"], ...extra }, (ctx) => {
    if (name === "files") return auditFilesCmd(ctx.args.PATHS as string[] | undefined ?? [], { json: ctx.opts.json === true });
    if (name === "hooks") return auditHooksCmd({ json: ctx.opts.json === true, run: ctx.opts.run === true, since: ctx.opts.since as string | undefined });
    if (name === "session") return auditSessionCmd(ctx.args.PATH as string | undefined, { json: ctx.opts.json === true, ctxThreshold: ctx.opts["ctx-threshold"] as string | undefined, history: ctx.opts.history as string | boolean | undefined, turn: ctx.opts.turn as string | undefined });
    if (name === "spawn") return auditSpawnCmd({ json: ctx.opts.json === true, n: ctx.opts.n as string | undefined, detail: ctx.opts.detail === true });
    if (name === "daemon") return auditDaemonCmd({ json: ctx.opts.json === true });
    if (name === "env") return auditEnvCmd({ json: ctx.opts.json === true });
    if (name === "schedule") return auditScheduleCmd({ json: ctx.opts.json === true });
    if (name === "skills") return auditSkillsCmd({ json: ctx.opts.json === true, top: ctx.opts.top as string | undefined });
    if (name === "subagents") return auditSubagentsCmd({ json: ctx.opts.json === true });
    if (name === "mcp") return auditMcpCmd({ json: ctx.opts.json === true, connect: ctx.opts.connect === true, since: ctx.opts.since as string | undefined });
    if (name === "ladder") return auditLadderCmd({ json: ctx.opts.json === true, live: ctx.opts.live === true, model: ctx.opts.model as string | undefined, mcpConfig: ctx.opts["mcp-config"] as string | undefined });
    return 0;
  });

export const auditCommand: CommandDef = {
  name: "audit",
  summary: "Find out where tokens are being spent",
  description: "Read-only reports on what your setup costs in tokens: memory files, hooks, sessions, helper sessions, background service, skills, MCP servers.",
  examples: ["pai audit tokens", "pai audit tokens session", "pai audit tokens mcp"],
  seeAlso: ["pai skill telemetry"],
  subcommands: [
    {
      name: "export",
      summary: "Export a tenant's audit trail (firings, decisions, outcomes) with a manifest",
      description:
        "Writes the tenant's firing and outcome lines in the time window as JSONL or CSV. Each line carries tenant, ruleId, ruleVersion (content hash of the rule file) and principal (token id, run id or session id, never a secret). The manifest lists the rule versions that fired in the window, the rule set as of the export, the PAI version, the export time and the sha256 of the export. Read-only. Without --out the export goes to stdout and the manifest to stderr; with --out the manifest is written to <file>.manifest.json.",
      options: [
        { name: "tenant", type: "string", value: "NAME", summary: "Tenant to export (required; \"local\" is the default tenant)" },
        { name: "since", type: "string", value: "ISO", summary: "Only lines at or after this time" },
        { name: "until", type: "string", value: "ISO", summary: "Only lines at or before this time" },
        { name: "format", type: "string", value: "jsonl|csv", default: "jsonl", summary: "Output format" },
        { name: "out", type: "string", value: "FILE", summary: "Write the export here (manifest beside it)" },
      ],
      examples: ["pai audit export --tenant acme", "pai audit export --tenant acme --since 2026-10-01T00:00:00Z --format csv --out acme.csv"],
      seeAlso: ["docs/tenants.md"],
      run: (ctx) => {
        const tenant = typeof ctx.opts.tenant === "string" ? ctx.opts.tenant : "";
        if (!tenant) throw new CliError("--tenant is required", "pai audit export --tenant <name>");
        let r: ReturnType<typeof exportAudit>;
        try {
          r = exportAudit({ tenant, since: ctx.opts.since as string | undefined, until: ctx.opts.until as string | undefined, format: (ctx.opts.format as "jsonl" | "csv" | undefined) ?? "jsonl" });
        } catch (e) {
          throw new CliError((e as Error).message, "pai audit export --tenant <name> [--since ISO] [--until ISO] [--format jsonl|csv]");
        }
        const manifest = JSON.stringify(r.manifest, null, 2) + "\n";
        if (typeof ctx.opts.out === "string" && ctx.opts.out) {
          writeFileSync(ctx.opts.out, r.body);
          writeFileSync(`${ctx.opts.out}.manifest.json`, manifest);
          process.stdout.write(manifest);
        } else {
          process.stdout.write(r.body);
          process.stderr.write(manifest);
        }
        return 0;
      },
    },
    {
      ...a({
        name: "tokens",
        summary: "Token-waste report (all checks, or pick one below)",
        description:
          "Runs every check and prints one combined report with findings ranked by severity. Run one check on its own with a sub-command: " +
          "files, hooks, session, spawn, daemon, env, schedule, skills, subagents, mcp, ladder.",
        options: [{ name: "record", type: "string", value: "DIR", summary: "Also write a dated, numbered Markdown and JSON snapshot into DIR" }],
        examples: ["pai audit tokens", "pai audit tokens --json", "pai audit tokens --record ./audits"],
        seeAlso: ["pai audit tokens mcp"],
      }, (ctx) => auditTokensCmd({ json: ctx.opts.json === true, record: ctx.opts.record as string | undefined })),
      subcommands: [
        t("files", "Token count per memory file", "Counts tokens of the CLAUDE.md chain, core skill, rule files and auto-memory, or of the files you name.", {
          args: [{ name: "PATHS", variadic: true, summary: "Files to count (default: the standard memory set)" } as ArgDef],
          examples: ["pai audit tokens files", "pai audit tokens files ./CLAUDE.md --json"],
        }),
        t("hooks", "Token cost and observed state of every start-up and prompt hook", "Lists each SessionStart and UserPromptSubmit hook with its state: observed (a capture for that event exists in the window), configured (never observed — the hook may silently not be running), or missing-script. With --run it executes them and measures what each adds to the context; without it nothing is executed.", {
          options: [
            { name: "run", type: "boolean", summary: "Execute the hooks to measure their output (runs the repository's own hook commands; trusted repositories only)" },
            { name: "since", type: "number", value: "HOURS", summary: "Observation window for the state column (default 24h)" },
          ],
          examples: ["pai audit tokens hooks", "pai audit tokens hooks --run", "pai audit tokens hooks --since 48"],
        }),
        t("session", "Token split for one session transcript", "Shows cache, input and output tokens of a session (default: the newest).", {
          args: [{ name: "PATH", summary: "Session transcript file (default: newest under ~/.claude/projects)" }],
          options: [
            { name: "ctx-threshold", type: "number", value: "N", summary: "Override the compaction trigger (default: derived from the session itself)" },
            { name: "history", type: "string", value: "N", summary: "List the first-turn context of the newest N sessions of this project (try 20)", optionalValue: true },
            { name: "turn", type: "number", value: "N", summary: "Explain where API call N's context growth came from" },
          ],
          examples: ["pai audit tokens session", "pai audit tokens session --history 20", "pai audit tokens session --turn 12"],
        }),
        t("spawn", "Helper-session overhead: subagents vs workers", "Compares the start-up cost of in-session subagents with pai workers.", {
          options: [
            { name: "n", short: "n", type: "number", value: "COUNT", summary: "How many of the newest logs per group to read (default 10)" },
            { name: "detail", type: "boolean", summary: "One row per log" },
          ],
          examples: ["pai audit tokens spawn", "pai audit tokens spawn -n 20 --detail"],
        }),
        t("daemon", "What the background service spent", "Counts model calls, extraction parse failures and queue sizes from the daemon log."),
        t("env", "Model and endpoint overrides on running sessions", "Lists ANTHROPIC_BASE_URL and model overrides of every live claude process."),
        t("schedule", "Scheduled jobs that beat the cache lifetime", "Finds launchd and cron entries that run more often than the prompt cache lives."),
        t("skills", "Token cost of the skill and command catalogue", "Sizes every SKILL.md, command and plugin, lists the top entries and duplicate names.", {
          options: [{ name: "top", type: "number", value: "N", summary: "How many top entries to show (default 15)" }],
          examples: ["pai audit tokens skills", "pai audit tokens skills --top 5"],
        }),
        t("subagents", "Token cost of subagent definitions", "Sizes each Claude Code subagent definition and shows how its model is pinned."),
        t("mcp", "MCP servers: configured, pinned, loaded, used", "Compares what is configured, what is pinned, what a live session loaded, what was used in the last 30 days, and what the capture hook saw in the observation window (a server with 0 calls there is configured, not used).", {
          options: [
            { name: "connect", type: "boolean", summary: "Actually connect to every stdio server to count its tools (has side effects)" },
            { name: "since", type: "number", value: "HOURS", summary: "Observation window for the calls and last seen columns (default 24h)" },
          ],
          examples: ["pai audit tokens mcp", "pai audit tokens mcp --connect", "pai audit tokens mcp --since 48"],
        }),
        a({
          name: "usage",
          summary: "Exact token totals per model for one session transcript",
          description:
            "Sums a Claude Code session transcript's assistant usage (each message id once, its final usage) per model. This is the tier-0 side of the A/B comparison: the top orchestrator session; its workers are `pai worker usage`.\n\n" +
            priceTableText(),
          args: [{ name: "TRANSCRIPT", required: true, summary: "Session transcript .jsonl" }],
          examples: ["pai audit tokens usage ~/.claude/projects/-my-proj/SESSION.jsonl", "pai audit tokens usage ./session.jsonl --json"],
          seeAlso: ["pai worker usage", "pai audit tokens session"],
        }, (ctx) => {
          const file = ctx.args.TRANSCRIPT as string;
          const rep = transcriptUsage(file);
          console.log(ctx.opts.json === true ? JSON.stringify(usageJson(rep), null, 2) : renderUsage(rep, { workers: false }));
          return 0;
        }),
        t("ladder", "LIVE: first-turn context per configuration step", "Starts real headless claude calls at growing configurations and measures the first-turn context. Refuses without --live because it costs money.", {
          options: [
            { name: "live", type: "boolean", summary: "Really start claude -p (billed); required" },
            { ...OPT.model, summary: "Model to probe with (default haiku)" },
            { name: "mcp-config", type: "string", value: "PATH", summary: "MCP config for the third step (default: newest *.mcp.json in the workers log folder)" },
          ],
          examples: ["pai audit tokens ladder", "pai audit tokens ladder --live --model haiku"],
        }),
      ],
    },
    a({
      name: "scan",
      summary: "After-the-fact security scan of a session or worker transcript",
      description:
        "Runs the rule set (the same rules the PreToolUse hook enforces, plus two-step sequence rules that only make sense after the fact) over a transcript: single-step rules against every tool call, sequence rules correlated across the run — credential read followed by an outbound call, download followed by execute, injected text followed by a shell call. Findings are grouped by severity; evidence is masked. Exit 1 when a block-severity finding hit.",
      args: [{ name: "PATH", summary: "Transcript .jsonl (default: newest session under ~/.claude/projects)" }],
      options: [
        { name: "session", type: "string", value: "ID", summary: "Scan this Claude Code session's transcript" },
        { name: "worker", type: "string", value: "ID", summary: "Scan a worker's transcript (its Claude session, else its event log)" },
      ],
      examples: ["pai audit scan", "pai audit scan --worker w-20260101-abc", "pai audit scan ./session.jsonl --json"],
      seeAlso: ["pai rules list", "pai audit tokens session"],
    }, (ctx) =>
      auditScanCmd({
        json: ctx.opts.json === true,
        session: ctx.opts.session as string | undefined,
        worker: ctx.opts.worker as string | undefined,
        path: ctx.args.PATH as string | undefined,
      })
    ),
  ],
};
