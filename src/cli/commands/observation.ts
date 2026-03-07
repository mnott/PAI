/**
 * pai observation <sub-command>
 *
 * list    — List recent observations with filtering options
 * search  — Search observations by title/narrative
 * stats   — Show observation statistics
 */

import type { Command } from "commander";
import { createConnection } from "net";
import { ok, warn, err, dim, bold, header } from "../utils.js";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// IPC helper — communicates with PAI daemon via Unix socket
// ---------------------------------------------------------------------------

function ipcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const client = createConnection("/tmp/pai.sock", () => {
      client.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });
    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString();
      // Daemon sends a single JSON line then closes — try parsing eagerly
      try {
        const resp = JSON.parse(data) as { ok: boolean; result: unknown; error?: string };
        client.end();
        settle(() => resp.ok ? resolve(resp.result) : reject(new Error(resp.error ?? "IPC call failed")));
      } catch {
        // Incomplete — wait for more data or end
      }
    });
    client.on("end", () => {
      settle(() => {
        try {
          const resp = JSON.parse(data) as { ok: boolean; result: unknown; error?: string };
          resp.ok ? resolve(resp.result) : reject(new Error(resp.error ?? "IPC call failed"));
        } catch (e) { reject(e); }
      });
    });
    client.on("error", (e) => settle(() => reject(e)));
    setTimeout(() => { client.destroy(); settle(() => reject(new Error("IPC timeout"))); }, 10000);
  });
}

// ---------------------------------------------------------------------------
// Type colour mapping
// ---------------------------------------------------------------------------

function typeColor(type: string): string {
  switch (type) {
    case "decision":  return chalk.cyan(type);
    case "bugfix":    return chalk.red(type);
    case "feature":   return chalk.green(type);
    case "refactor":  return chalk.yellow(type);
    case "discovery": return chalk.blue(type);
    case "change":    return chalk.magenta(type);
    default:          return chalk.white(type);
  }
}

// ---------------------------------------------------------------------------
// Date formatting helper
// ---------------------------------------------------------------------------

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return dim("—");
  try {
    const d = new Date(ts);
    const date = d.toISOString().slice(0, 10);
    const time = d.toISOString().slice(11, 16);
    return `${date} ${time}`;
  } catch {
    return dim("—");
  }
}

// ---------------------------------------------------------------------------
// Truncate a string to maxLen visible characters
// ---------------------------------------------------------------------------

function trunc(s: string, maxLen: number): string {
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

// ---------------------------------------------------------------------------
// Observation shape (from IPC responses)
// ---------------------------------------------------------------------------

interface Observation {
  id: number;
  type: string;
  title: string;
  project_slug?: string | null;
  session_id?: string | null;
  created_at: string;
  narrative?: string | null;
}

interface ObservationStats {
  total: number;
  by_type: Array<{ type: string; count: number }>;
  by_project: Array<{ project_slug: string | null; count: number }>;
  most_recent: string | null;
}

// ---------------------------------------------------------------------------
// Command: pai observation list
// ---------------------------------------------------------------------------

async function cmdList(opts: {
  project?: string;
  type?: string;
  session?: string;
  limit?: string;
}): Promise<void> {
  const limit = parseInt(opts.limit ?? "20", 10);

  const params: Record<string, unknown> = { limit };
  if (opts.project) params.project_slug = opts.project;
  if (opts.type)    params.type = opts.type;
  if (opts.session) params.session_id = opts.session;

  let observations: Observation[];
  try {
    observations = (await ipcCall("observation_list", params)) as Observation[];
  } catch (e) {
    console.error(err(`  Failed to reach PAI daemon: ${e}`));
    console.error(dim("  Is the daemon running? Try: pai daemon status"));
    process.exit(1);
  }

  console.log();
  console.log(header("  PAI Observations"));

  const filterParts: string[] = [];
  if (opts.project) filterParts.push(`project: ${opts.project}`);
  if (opts.type)    filterParts.push(`type: ${opts.type}`);
  if (opts.session) filterParts.push(`session: ${opts.session}`);
  filterParts.push(`limit: ${limit}`);
  console.log(dim(`  ${filterParts.join("  |  ")}`));
  console.log();

  if (!observations || observations.length === 0) {
    console.log(warn("  No observations found."));
    console.log();
    return;
  }

  // Column widths
  const ID_W    = 4;
  const TYPE_W  = 10;
  const TITLE_W = 42;
  const PROJ_W  = 14;
  const TS_W    = 16;

  // Header row
  console.log(
    "  " +
    bold("id".padEnd(ID_W)) + "  " +
    bold("type".padEnd(TYPE_W)) + "  " +
    bold("title".padEnd(TITLE_W)) + "  " +
    bold("project".padEnd(PROJ_W)) + "  " +
    bold("created_at")
  );
  console.log(
    dim(
      "  " +
      "-".repeat(ID_W) + "  " +
      "-".repeat(TYPE_W) + "  " +
      "-".repeat(TITLE_W) + "  " +
      "-".repeat(PROJ_W) + "  " +
      "-".repeat(TS_W)
    )
  );

  for (const obs of observations) {
    const idStr      = String(obs.id).padStart(ID_W, " ");
    const typeStr    = typeColor(obs.type ?? "").padEnd(TYPE_W + (typeColor(obs.type ?? "").length - (obs.type ?? "").length));
    const titleStr   = trunc(obs.title ?? "", TITLE_W).padEnd(TITLE_W);
    const projStr    = trunc(obs.project_slug ?? "—", PROJ_W).padEnd(PROJ_W);
    const tsStr      = fmtTs(obs.created_at);

    console.log(`  ${idStr}  ${typeStr}  ${titleStr}  ${projStr}  ${dim(tsStr)}`);
  }

  console.log();
  console.log(dim(`  ${observations.length} observation(s)`));
  console.log();
}

// ---------------------------------------------------------------------------
// Command: pai observation search <query>
// ---------------------------------------------------------------------------

async function cmdSearch(
  query: string,
  opts: { project?: string; type?: string; limit?: string }
): Promise<void> {
  const limit = parseInt(opts.limit ?? "20", 10);

  const params: Record<string, unknown> = { query, limit };
  if (opts.project) params.project_slug = opts.project;
  if (opts.type)    params.type = opts.type;

  let allObservations: Observation[];
  try {
    // Fetch more than requested to allow client-side text filtering
    allObservations = (await ipcCall("observation_query", { ...params, limit: limit * 5, query: undefined })) as Observation[];
  } catch (e) {
    console.error(err(`  Failed to reach PAI daemon: ${e}`));
    console.error(dim("  Is the daemon running? Try: pai daemon status"));
    process.exit(1);
  }

  // Client-side text filter (observation_query doesn't support text search)
  const q = query.toLowerCase();
  const observations = allObservations
    .filter(o =>
      (o.title ?? "").toLowerCase().includes(q) ||
      (o.narrative ?? "").toLowerCase().includes(q) ||
      (o.tool_input_summary ?? "").toLowerCase().includes(q)
    )
    .slice(0, limit);

  console.log();
  console.log(header("  PAI Observation Search"));
  console.log(dim(`  Query: "${query}"${opts.project ? `  project: ${opts.project}` : ""}${opts.type ? `  type: ${opts.type}` : ""}  limit: ${limit}`));
  console.log();

  if (!observations || observations.length === 0) {
    console.log(warn(`  No observations matching "${query}".`));
    console.log();
    return;
  }

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const idx = chalk.dim(String(i + 1).padStart(3, " "));
    const type = typeColor(obs.type ?? "");
    const title = bold(obs.title ?? "(untitled)");
    const proj = obs.project_slug ? dim(`[${obs.project_slug}]`) : dim("[—]");
    const ts = dim(fmtTs(obs.created_at));
    const id = dim(`#${obs.id}`);

    console.log(`  ${idx}  ${type.padEnd(12)}  ${title}`);
    console.log(`           ${proj}  ${ts}  ${id}`);

    if (obs.narrative) {
      const snippet = trunc(obs.narrative.replace(/\n/g, " "), 160);
      console.log(`           ${dim(snippet)}`);
    }
    console.log();
  }

  console.log(dim(`  ${observations.length} result(s)`));
  console.log();
}

// ---------------------------------------------------------------------------
// Command: pai observation stats
// ---------------------------------------------------------------------------

async function cmdStats(): Promise<void> {
  let stats: ObservationStats;
  try {
    stats = (await ipcCall("observation_stats", {})) as ObservationStats;
  } catch (e) {
    console.error(err(`  Failed to reach PAI daemon: ${e}`));
    console.error(dim("  Is the daemon running? Try: pai daemon status"));
    process.exit(1);
  }

  console.log();
  console.log(header("  PAI Observation Statistics"));
  console.log();

  console.log(`  ${bold("Total observations:")}  ${chalk.cyan(String(stats.total ?? 0))}`);
  if (stats.most_recent) {
    console.log(`  ${bold("Most recent:")}         ${dim(fmtTs(stats.most_recent))}`);
  }
  console.log();

  // By type
  if (stats.by_type && stats.by_type.length > 0) {
    console.log(bold("  By type:"));
    const maxCount = Math.max(...stats.by_type.map((r) => r.count));
    for (const row of stats.by_type) {
      const barWidth = 20;
      const filled = Math.round((row.count / maxCount) * barWidth);
      const bar = chalk.cyan("█".repeat(filled)) + dim("░".repeat(barWidth - filled));
      const label = typeColor(row.type).padEnd(12 + (typeColor(row.type).length - row.type.length));
      console.log(`    ${label}  ${bar}  ${String(row.count).padStart(5)}`);
    }
    console.log();
  }

  // By project
  if (stats.by_project && stats.by_project.length > 0) {
    console.log(bold("  By project:"));
    const maxCount = Math.max(...stats.by_project.map((r) => r.count));
    const show = stats.by_project.slice(0, 15);
    for (const row of show) {
      const barWidth = 20;
      const filled = Math.round((row.count / maxCount) * barWidth);
      const bar = chalk.green("█".repeat(filled)) + dim("░".repeat(barWidth - filled));
      const label = (row.project_slug ?? "—").padEnd(20);
      console.log(`    ${dim(label)}  ${bar}  ${String(row.count).padStart(5)}`);
    }
    if (stats.by_project.length > 15) {
      console.log(dim(`    ... and ${stats.by_project.length - 15} more project(s)`));
    }
    console.log();
  }

  if ((!stats.by_type || stats.by_type.length === 0) && (!stats.by_project || stats.by_project.length === 0)) {
    console.log(warn("  No observation data yet."));
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerObservationCommands(parent: Command): void {
  // pai observation list
  parent
    .command("list")
    .description("List recent observations")
    .option("--project <slug>", "Filter by project slug")
    .option("--type <type>", "Filter by type (decision, bugfix, feature, refactor, discovery, change)")
    .option("--session <id>", "Filter by session ID")
    .option("--limit <n>", "Maximum results", "20")
    .action(async (opts: { project?: string; type?: string; session?: string; limit?: string }) => {
      try {
        await cmdList(opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });

  // pai observation search <query>
  parent
    .command("search <query>")
    .description("Search observations by title or narrative text")
    .option("--project <slug>", "Filter by project slug")
    .option("--type <type>", "Filter by type")
    .option("--limit <n>", "Maximum results", "20")
    .action(async (query: string, opts: { project?: string; type?: string; limit?: string }) => {
      try {
        await cmdSearch(query, opts);
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });

  // pai observation stats
  parent
    .command("stats")
    .description("Show observation statistics: totals, by type, by project")
    .action(async () => {
      try {
        await cmdStats();
      } catch (e) {
        console.error(err(`  Error: ${e}`));
        process.exit(1);
      }
    });
}
