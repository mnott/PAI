/**
 * pai skill <sub-command>
 *
 * telemetry — Show skill-invocation telemetry (self-educating skill system).
 *
 * The `skill` namespace is reserved for the wider self-educating loop
 * (search / install / audit / trial) — see Notes/swarm/skills-self-educating.md.
 */

import { warn, err, dim, bold, header } from "./utils.js";
import chalk from "chalk";
import { ipcCall } from "./daemon-ipc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return dim("—");
  try {
    const d = new Date(ts);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
  } catch {
    return dim("—");
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "active":   return chalk.green(status);
    case "trial":    return chalk.yellow(status);
    case "archived": return chalk.dim(status);
    default:         return chalk.white(status);
  }
}

function trunc(s: string, maxLen: number): string {
  if (!s) return "";
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

interface SkillTelemetry {
  id: number;
  scope: string;
  skill_name: string;
  source: string;
  status: string;
  trigger_count: number;
  accept_count: number;
  first_triggered: string;
  last_triggered: string;
  context_projects: string[];
  hash: string | null;
  audit_status: string | null;
  last_audited: string | null;
}

// ---------------------------------------------------------------------------
// Command: pai skill telemetry
// ---------------------------------------------------------------------------

export async function skillTelemetryCmd(opts: {
  scope?: string;
  status?: string;
  limit?: number;
  json?: boolean;
}): Promise<number> {
  const params: Record<string, unknown> = {
    scope: opts.scope ?? "default",
    limit: opts.limit ?? 50,
  };
  if (opts.status) params.status = opts.status;

  let rows: SkillTelemetry[];
  try {
    rows = (await ipcCall("skill_telemetry_query", params)) as SkillTelemetry[];
  } catch (e) {
    console.error(err(`  Failed to reach PAI daemon: ${e}`));
    console.error(dim("  Is the daemon running? Try: pai daemon status"));
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(rows ?? [], null, 2));
    return 0;
  }

  console.log();
  console.log(header("  Skill Telemetry"));
  console.log(dim(`  scope: ${params.scope}${opts.status ? `  |  status: ${opts.status}` : ""}`));
  console.log();

  if (!rows || rows.length === 0) {
    console.log(warn("  No skill telemetry yet."));
    console.log(dim("  Invoke a skill (e.g. /name) and it will be recorded."));
    console.log();
    return 0;
  }

  const NAME_W = 24;
  const SRC_W  = 10;
  const STAT_W = 9;
  const TRIG_W = 8;
  const SEEN_W = 16;

  console.log(
    "  " +
    bold("skill".padEnd(NAME_W)) + "  " +
    bold("source".padEnd(SRC_W)) + "  " +
    bold("status".padEnd(STAT_W)) + "  " +
    bold("triggers".padStart(TRIG_W)) + "  " +
    bold("last used".padEnd(SEEN_W)) + "  " +
    bold("projects")
  );
  console.log(dim("  " + "-".repeat(NAME_W + SRC_W + STAT_W + TRIG_W + SEEN_W + 18)));

  for (const r of rows) {
    const name   = trunc(r.skill_name ?? "", NAME_W).padEnd(NAME_W);
    const src    = trunc(r.source ?? "", SRC_W).padEnd(SRC_W);
    const stat   = statusColor(r.status ?? "");
    const statPad = stat.padEnd(STAT_W + (stat.length - (r.status ?? "").length));
    const trig   = String(r.trigger_count ?? 0).padStart(TRIG_W);
    const seen   = fmtTs(r.last_triggered).padEnd(SEEN_W);
    const projs  = Array.isArray(r.context_projects) ? r.context_projects.join(", ") : "";
    console.log(`  ${chalk.white(name)}  ${dim(src)}  ${statPad}  ${chalk.cyan(trig)}  ${dim(seen)}  ${dim(trunc(projs, 30))}`);
  }

  console.log();
  console.log(dim(`  ${rows.length} skill(s)`));
  console.log();
  return 0;
}
