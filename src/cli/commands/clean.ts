/** `pai clean`: plonge-style cleanup of what PAI itself leaves on disk (behaviour in workers/clean.ts). */

import { CliError, type CommandDef } from "../define.js";
import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";
import { applyClean, renderScan, scanClean, totals } from "../../workers/clean.js";

const num = (v: unknown, name: string, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`bad --${name} "${String(v)}"`, `pai clean --${name} 24`);
  return n;
};

/** "500M", "2G", "100K" or plain bytes. */
export function parseSize(v: unknown): number {
  if (v === undefined) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(v).trim());
  if (!m) throw new CliError(`bad --min-size "${String(v)}"`, "pai clean --min-size 100M");
  return Math.round(Number(m[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as Record<string, number>)[m[2]!.toLowerCase()]!);
}

export const cleanCommand: CommandDef = {
  name: "clean",
  summary: "Clean up what PAI leaves on disk (dry run unless --apply)",
  description:
    "Scans the worker log dir for four kinds of leftovers and lists them with category, size, age, owner and the rule that matched; nothing changes without --apply, which acts on exactly what the dry run with the same options lists. (1) Finished workers' worktrees: archived through `pai worker gc` (commits under refs/pai-archive, notes salvaged). (2) Top-level files (transcript, status, prompt, socket, settings, waits, loop-guard) of workers finished more than 14 days ago: moved into archive/YYYY-MM, never deleted. (3) supervision/*.events and *.pushed of sessions no live worker names, quiet for 14 days: deleted. (4) Build dirs outside the tree (DerivedData under the temp dir) that a finished worker recorded in the ledger and that are quiet: deleted. Refused, listed with the reason and outside the totals: anything a live worker or process owns, symlinks, paths outside their root, git repos with uncommitted or unpushed work. ledger.log is never touched. After --apply the estimated freed bytes and the measured free-space change are printed. Out of scope: global developer caches (~/.npm, ~/Library/Caches, DerivedData of ordinary projects); use plonge (https://github.com/mattt/plonge) for those.",
  options: [
    { name: "apply", type: "boolean", summary: "Do it: act on exactly the listed items" },
    { name: "json", type: "boolean", summary: "Machine-readable output (dry run and apply)" },
    { name: "min-size", type: "string", value: "SIZE", summary: "Ignore items smaller than SIZE (500K, 100M, 2G)" },
    { name: "older-than", type: "string", value: "HOURS", default: "24", summary: "Quiet period in hours for worktrees and build dirs (worker files and supervision markers always wait at least 14 days)" },
  ],
  examples: ["pai clean", "pai clean --min-size 500M", "pai clean --older-than 72 --json", "pai clean --apply"],
  seeAlso: ["pai worker gc", "pai worker ps"],
  run: async (ctx) => {
    const logDir = workersLogDir(readWorkersSection().workers);
    const opts = { olderThanHours: num(ctx.opts["older-than"], "older-than", 24), minBytes: parseSize(ctx.opts["min-size"]) };
    const apply = ctx.opts.apply === true;
    const json = ctx.opts.json === true;
    const scan = scanClean(logDir, opts);
    const res = apply ? applyClean(logDir, scan, opts) : null;
    if (json) {
      console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", options: opts, items: scan.items, refused: scan.refused, totals: totals(scan.items), ...(res ? { result: res } : {}) }, null, 2));
    } else {
      for (const l of renderScan(scan, res)) console.log(l);
    }
    return res && res.failed.length ? 1 : 0;
  },
};
