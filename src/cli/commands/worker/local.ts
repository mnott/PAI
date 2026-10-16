/**
 * `pai worker local <tier>|off|status` — switch which single local model
 * server runs. Does not change worker routing (`pai worker use` does).
 */

import type { Command } from "commander";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { workersYamlPath } from "../../../workers/workers-config.js";
import {
  fmtRss, LocalTierError, parseServers, planStart, readLocalConfig, stopLine,
  type LocalConfig, type RunningServer,
} from "../../../workers/local-tiers.js";
import { ok, err, dim } from "../../utils.js";

const READY_TIMEOUT_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listServers(cfg: LocalConfig): RunningServer[] {
  const out = execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return parseServers(out, cfg);
}

async function stopAll(cfg: LocalConfig): Promise<void> {
  const servers = listServers(cfg);
  for (const s of servers) process.kill(s.pid, "SIGTERM");
  const deadline = Date.now() + 60_000;
  while (listServers(cfg).length > 0 && Date.now() < deadline) await sleep(1000);
  for (const s of listServers(cfg)) process.kill(s.pid, "SIGKILL");
}

async function isUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

function printStatus(cfg: LocalConfig): void {
  const servers = listServers(cfg);
  if (servers.length === 0) {
    console.log(dim("no local model server running"));
  }
  for (const s of servers) {
    console.log(`${s.tier ?? "?"}  provider=${s.provider ?? "?"}  port=${s.port ?? "?"}  pid=${s.pid}  rss=${fmtRss(s.rssKb)}`);
  }
  console.log(dim(`tiers: ${Object.keys(cfg.tiers).join(", ") || "(none configured)"}`));
}

export function registerWorkerLocalCommand(workerCmd: Command): void {
  workerCmd
    .command("local <target>")
    .description(
      "Switch the one running local model server: <tier> (stop all, start that tier),\n" +
        "off (stop all), status (what is up). Tiers come from local_tiers: in workers.yaml.\n" +
        "Does not change worker routing."
    )
    .option("--dry-run", "Print the exact commands without starting or stopping anything")
    .action(async (target: string, opts: { dryRun?: boolean }) => {
      try {
        const cfg = readLocalConfig(workersYamlPath());
        if (target === "status") return printStatus(cfg);
        if (target === "off") {
          if (opts.dryRun) return void console.log(stopLine(cfg));
          await stopAll(cfg);
          console.log(ok("local model servers stopped"));
          return;
        }
        const tier = cfg.tiers[target];
        if (!tier) {
          throw new LocalTierError(`no tier "${target}" (configured: ${Object.keys(cfg.tiers).join(", ") || "none"})`);
        }
        const plan = planStart(cfg, tier);
        if (opts.dryRun) {
          console.log(stopLine(cfg));
          console.log("sleep 10");
          console.log(plan.line);
          console.log(`until curl -s -m 3 http://127.0.0.1:${tier.port}/v1/models > /dev/null; do sleep 5; done`);
          return;
        }
        await stopAll(cfg);
        mkdirSync(dirname(plan.logPath), { recursive: true });
        const fd = openSync(plan.logPath, "w");
        const [cmd, ...args] = plan.argv;
        const child = spawn(cmd, args, {
          env: { ...process.env, ...plan.env },
          detached: true,
          stdio: ["ignore", fd, fd],
        });
        child.unref();
        closeSync(fd);
        console.log(dim(`starting ${tier.provider} (${tier.served}) on :${tier.port}, log ${plan.logPath}`));
        const deadline = Date.now() + READY_TIMEOUT_MS;
        while (!(await isUp(tier.port))) {
          if (child.exitCode !== null) throw new LocalTierError(`server exited (${child.exitCode}); see ${plan.logPath}`);
          if (Date.now() > deadline) throw new LocalTierError(`not ready after 10 min; see ${plan.logPath}`);
          await sleep(5000);
        }
        const s = listServers(cfg).find((x) => x.port === tier.port);
        console.log(ok(`${target} up: ${tier.provider} on port ${tier.port}${s ? `, rss ${fmtRss(s.rssKb)}` : ""}`));
      } catch (e) {
        console.error(err("pai worker local: ") + (e instanceof Error ? e.message : String(e)));
        process.exitCode = 1;
      }
    });
}
