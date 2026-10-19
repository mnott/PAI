/** `pai home` — where PAI's home is, and the one-time move out of ~/.claude/pai. Behaviour lives here; src/cli/commands/home.ts declares help. */

import { homedir } from "node:os";
import { paiHomeDir, paiHomePath } from "../../config/pai-home.js";
import { applyHomeMigration, planHomeMigration, renderTable, sizeOf, type HomeMigrationPlan } from "../../config/home-migrate.js";
import { resolveDaemonPid } from "../../daemon/daemon-pid.js";
import { routerRunningPid } from "../../router/supervisor.js";
import { isLive, loadStatuses } from "../../workers/status.js";
import { bold, dim, err, ok, warn } from "../lib/utils.js";

export function homePathCmd(): number {
  console.log(paiHomeDir());
  return 0;
}

/** What is still running and has to be stopped first (empty = clear). Own process and its parent are not counted. */
export function runningThings(): string[] {
  const out: string[] = [];
  const d = resolveDaemonPid();
  if (d) out.push(`PAI daemon (pid ${d}) — run \`pai daemon uninstall\` (stops the service; \`pai daemon install\` after the move)`);
  const r = routerRunningPid();
  if (r) out.push(`PAI router (pid ${r}) — run \`pai router stop\``);
  for (const s of loadStatuses(paiHomePath("logs", "workers"))) {
    if (s.pid === process.pid || s.pid === process.ppid) continue;
    if (isLive(s)) out.push(`worker ${s.id} (pid ${s.pid}) — wait for it or \`pai worker kill ${s.id}\``);
  }
  return out;
}

export function printPlan(plan: HomeMigrationPlan, home: string, dryRun: boolean): void {
  console.log(bold(`  PAI home migration${dryRun ? " (dry run)" : ""}`));
  console.log(dim(`  ${plan.src}  ->  ${plan.dst}`));
  console.log();
  if (plan.skip) {
    console.log(ok(`  ${plan.skip}`));
    return;
  }
  console.log(renderTable(plan, sizeOf, home).replace(/^/gm, "  "));
  console.log();
  const attic = plan.moves.filter((m) => m.kind === "attic").length;
  console.log(dim(`  ${plan.moves.length - attic} entries moved by rename, ${attic} leftovers to ${plan.attic}`));
  for (const r of plan.rewrites) console.log(dim(`  rewrite ${r.occurrences} path(s) in ${r.file}`));
  if (!plan.rewrites.length) console.log(dim("  no paths to rewrite"));
  if (plan.rewrites.some((r) => r.file.includes("LaunchAgents"))) {
    console.log(dim("  launchd plists change on disk only — reload them (pai daemon install) after the move"));
  }
}

export function homeMigrateCmd(opts: { dryRun?: boolean }, home: string = homedir(), running: () => string[] = runningThings): number {
  const dryRun = !!opts.dryRun;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const plan = planHomeMigration({ home, date });
  printPlan(plan, home, dryRun);

  const busy = running();
  if (busy.length) {
    console.log();
    console.log(warn("  still running — stop before migrating:"));
    for (const b of busy) console.log(warn(`    ${b}`));
  }
  if (plan.clashes.length) {
    console.log();
    console.log(err("  name clashes between the two homes (resolve by hand, nothing was changed):"));
    for (const c of plan.clashes) console.log(err(`    ${c}`));
  }
  if (dryRun || plan.skip) return plan.clashes.length || busy.length ? 1 : 0;
  if (busy.length || plan.clashes.length) return 1;

  try {
    const r = applyHomeMigration(plan, home);
    console.log();
    console.log(ok(`  done: ${r.moved} entries moved, ${r.rewritten} file(s) rewritten, ${plan.src} -> ${plan.dst}`));
    return 0;
  } catch (e) {
    console.log(err(`  ${(e as Error).message}`));
    return 1;
  }
}
