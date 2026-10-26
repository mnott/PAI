/** `pai antipatterns ...`: govern the anti-pattern directory (lifecycle, firings, candidates). */

import { CliError, type ArgDef, type CommandDef, type OptDef, type RunContext } from "../define.js";
import { renderTable } from "../lib/utils.js";
import { DISPOSITIONS, type Disposition } from "../../hooks/ts/lib/antipattern-log.js";
import { candidates, conflicts, label, listPatterns, parseSince, promote, retire, setMode, setParam, stats } from "../../antipatterns/govern.js";

const ID: ArgDef = { name: "ID", summary: "Pattern id (see: pai antipatterns list)", required: true };
const JSON_OPT: OptDef = { name: "json", type: "boolean", default: false, summary: "Machine-readable JSON output" };

const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
};

const pct = (n: number | null): string => (n === null ? "-" : `${Math.round(n * 100)}%`);
const mix = (m: Record<string, number>): string => Object.entries(m).map(([k, v]) => `${k}:${v}`).join(" ") || "-";

function show(ctx: RunContext, data: unknown, table: () => string): number {
  console.log(ctx.opts.json === true ? JSON.stringify(data, null, 2) : table());
  return 0;
}

export const antipatternsCommand: CommandDef = {
  name: "antipatterns",
  summary: "Anti-patterns: status, firings, candidates, retirement",
  description:
    "The anti-pattern directory (shipped antipatterns/<category>/<id>.yaml plus your own under PAI_HOME/antipatterns). " +
    "Every guard firing is recorded; these commands show which patterns fire, on which model and with what outcome, " +
    "promote new cases caught by guards, and switch patterns between enforce and monitor or retire them. " +
    "Shipped files are never edited: a change writes a user override file with the same id.",
  examples: ["pai antipatterns list --status stable", "pai antipatterns stats --since 7d", "pai antipatterns candidates"],
  seeAlso: ["pai rules list"],
  subcommands: [
    {
      name: "list",
      summary: "Every pattern with status, mode and version",
      description: "Shell rules and every other category. Filter with --category and --status (experimental, test, stable, deprecated).",
      options: [{ name: "category", type: "string", value: "NAME", summary: "shell, tool-loop, final-text or paths" }, { name: "status", type: "string", value: "STATUS", summary: "experimental, test, stable or deprecated" }, JSON_OPT],
      examples: ["pai antipatterns list --category tool-loop"],
      run: (ctx) => {
        const rows = listPatterns({ category: ctx.opts.category as string | undefined, status: ctx.opts.status as string | undefined });
        return show(ctx, rows, () => renderTable(["id", "category", "status", "mode", "v", "action", "source"], rows.map((e) => [e.id, e.category, e.status, e.mode, String(e.version), e.action, e.source])));
      },
    },
    {
      name: "stats",
      summary: "Firing counts, models, outcomes and health flags per pattern",
      description:
        "Per pattern: firings, last fired, firings per model, actions, outcome mix, false-positive rate (fp/(tp+fp) over labelled firings), override rate. " +
        "Flags: false-positive suspect (a deny or stop followed by a successful run, except in the paths category where that is the rule working, or a monitor hit with no bad outcome), model-quirk (over 90% of at least 5 firings on one model), " +
        "retire candidate (no firing in 30 days, or false-positive rate over 50% across at least 10 labelled firings).",
      options: [{ name: "since", type: "string", value: "AGE", summary: "Only firings newer than this, e.g. 12h, 7d, 2w" }, { name: "model", type: "string", value: "ID", summary: "Only firings on this model" }, { name: "source", type: "string", value: "hook|proxy", summary: "Only firings decided by the hooks or by the model-API proxy" }, JSON_OPT],
      examples: ["pai antipatterns stats --since 7d", "pai antipatterns stats --model glm-5", "pai antipatterns stats --source proxy"],
      run: (ctx) => {
        const rows = wrap(() => stats({ sinceMs: ctx.opts.since ? parseSince(String(ctx.opts.since)) : undefined, model: ctx.opts.model as string | undefined, source: ctx.opts.source as "hook" | "proxy" | undefined }));
        return show(ctx, rows, () =>
          renderTable(
            ["id", "n", "last fired", "src", "models", "actions", "outcomes", "fp", "override", "flags"],
            rows.map((r) => [r.id, String(r.count), r.lastFired?.slice(0, 16) ?? "never", mix(r.bySource), mix(r.byModel), mix(r.actions), mix(r.outcomes), pct(r.fpRate), pct(r.overrideRate), [...(r.falsePositiveSuspect ? ["false-positive suspect"] : []), ...r.flags].join(", ")]),
          ),
        );
      },
    },
    {
      name: "candidates",
      summary: "Cases a guard stopped that no pattern covers",
      description: "Inactive files under PAI_HOME/antipatterns/_candidates. Review, then `pai antipatterns promote ID`.",
      options: [JSON_OPT],
      examples: ["pai antipatterns candidates"],
      run: (ctx) => {
        const rows = candidates();
        return show(ctx, rows, () => (rows.length ? renderTable(["id", "category", "created", "action", "observed"], rows.map((c) => [c.id, c.category, c.created, c.action, c.excerpt.slice(0, 60)])) : "No candidates."));
      },
    },
    {
      name: "promote",
      summary: "Make a candidate a pattern (status test, mode monitor)",
      description: "Moves the candidate into PAI_HOME/antipatterns/<category>/. It starts in monitor mode: it records, it does not act.",
      args: [ID],
      examples: ["pai antipatterns promote cand-1a2b3c4d"],
      run: (ctx) => {
        console.log(wrap(() => promote(ctx.args.ID as string)));
        return 0;
      },
    },
    {
      name: "enforce",
      summary: "Switch a pattern to enforce mode",
      description: "Writes a user override with mode: enforce.",
      args: [ID],
      examples: ["pai antipatterns enforce repeated-failure"],
      run: (ctx) => {
        console.log(wrap(() => setMode(ctx.args.ID as string, "enforce")).path);
        return 0;
      },
    },
    {
      name: "monitor",
      summary: "Switch a pattern to monitor mode (record, take no action)",
      description: "Writes a user override with mode: monitor.",
      args: [ID],
      examples: ["pai antipatterns monitor git-reset-hard"],
      run: (ctx) => {
        console.log(wrap(() => setMode(ctx.args.ID as string, "monitor")).path);
        return 0;
      },
    },
    {
      name: "retire",
      summary: "Retire a pattern (status deprecated)",
      description: "Writes a user override with status: deprecated; a deprecated pattern does nothing. Shipped files are never deleted.",
      args: [ID],
      options: [{ name: "reason", type: "string", value: "TEXT", summary: "Why it is retired" }],
      examples: ["pai antipatterns retire revert --reason 'never fired in 60 days'"],
      run: (ctx) => {
        console.log(wrap(() => retire(ctx.args.ID as string, ctx.opts.reason as string | undefined)).path);
        return 0;
      },
    },
    {
      name: "set",
      summary: "Change one detector parameter of a pattern",
      description:
        "Writes the user override (a full copy of the active file on first use), sets detector.params.PARAM to VALUE (numbers and booleans are parsed), " +
        "bumps version, sets modified and appends to the file's changes list and to antipatterns/governance.jsonl. Unknown params and type mismatches are refused. Takes effect without a restart.",
      args: [ID, { name: "PARAM", summary: "Detector parameter, e.g. stop_at", required: true }, { name: "VALUE", summary: "New value", required: true }],
      options: [{ name: "reason", type: "string", value: "TEXT", summary: "Why (required)" }],
      examples: ["pai antipatterns set identical-write stop_at 8 --reason 'loops cost too much'"],
      run: (ctx) => {
        const r = wrap(() => setParam(ctx.args.ID as string, ctx.args.PARAM as string, ctx.args.VALUE as string, (ctx.opts.reason as string | undefined) ?? ""));
        console.log(`${ctx.args.PARAM}: ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)} (v${r.version}) ${r.path}`);
        return 0;
      },
    },
    {
      name: "label",
      summary: "Label a firing (or all firings of a pattern) tp, fp or benign_tp",
      description: "TARGET is a firing's ts (from firings.jsonl) or a pattern id. Labels feed the false-positive rate in stats.",
      args: [{ name: "TARGET", summary: "Firing ts or pattern id", required: true }, { name: "DISPOSITION", summary: DISPOSITIONS.filter((d) => d !== "undetermined").join(" | "), required: true }],
      examples: ["pai antipatterns label git-reset-hard fp"],
      run: (ctx) => {
        const n = wrap(() => label(ctx.args.TARGET as string, ctx.args.DISPOSITION as Disposition));
        console.log(`labelled ${n} firing${n === 1 ? "" : "s"}`);
        return 0;
      },
    },
    {
      name: "conflicts",
      summary: "Duplicate ids and patterns that match each other's fixtures with different actions",
      description: "Exit 1 when there is a conflict.",
      options: [JSON_OPT],
      examples: ["pai antipatterns conflicts"],
      run: (ctx) => {
        const rows = conflicts();
        show(ctx, rows, () => (rows.length ? rows.map((c) => `${c.kind}: ${c.detail}`).join("\n") : "No conflicts."));
        return rows.length ? 1 : 0;
      },
    },
  ],
};
