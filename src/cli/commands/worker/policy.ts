/**
 * `pai worker policy` — where workers run: cloud, local, or a fall-through.
 * No args shows the policy and the route a plain run would take now.
 */

import type { Command } from "commander";
import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import {
  POLICY_MODES,
  clearPolicy,
  findLocal,
  onBattery,
  parseDuration,
  readPolicy,
  routeRun,
  writePolicy,
  type PolicyMode,
} from "../../../workers/policy.js";
import { err } from "../../utils.js";

export function registerWorkerPolicyCommand(workerCmd: Command): void {
  workerCmd
    .command("policy [mode]")
    .description(
      "Where workers run. No mode shows the policy; a mode sets it; `clear` removes it\n" +
        "(class/active routing as before).\n" +
        "  cloud-only    never local (battery, on the road)\n" +
        "  local-only    never cloud (conserve tokens); fails if no local server answers\n" +
        "  prefer-local  local first; a local run with a bad report is repeated once on the cloud\n" +
        "  prefer-cloud  cloud first (fast turnaround); local only when the cloud is unavailable\n" +
        "  auto          prefer-local, but cloud on battery and for an --urgent run\n" +
        "Per run: --urgent, --local-ok, --cloud; --provider beats the policy."
    )
    .option("--for <duration>", "Expire the policy after 30m, 2h, 1d …")
    .action(async (mode: string | undefined, opts: { for?: string }) => {
      try {
        const config = readWorkersSection().workers;
        const logDir = workersLogDir(config);
        if (mode === "clear") {
          clearPolicy(logDir);
          console.log("policy: none (class/active routing)");
          return;
        }
        if (mode !== undefined) {
          if (!(POLICY_MODES as readonly string[]).includes(mode)) {
            throw new Error(`policy: expected one of ${POLICY_MODES.join(", ")}, clear — got "${mode}"`);
          }
          const p = writePolicy(logDir, mode as PolicyMode, opts.for ? parseDuration(opts.for) : undefined);
          console.log(`policy: ${p.mode}${p.until ? ` until ${p.until}` : ""}`);
          return;
        }
        const p = readPolicy(logDir);
        console.log(`policy: ${p ? `${p.mode}${p.until ? ` until ${p.until}` : ""}` : "none (class/active routing)"}`);
        const local = await findLocal(config, logDir);
        console.log(`local:   ${local.name ?? local.why}`);
        console.log(`battery: ${onBattery() ? "yes" : "no"}`);
        const r = await routeRun(config, logDir, {}).catch((e: Error) => ({ error: e.message }));
        if (r && "error" in r) console.log(`next run: fails — ${r.error}`);
        else if (r) console.log(`next run: ${r.providerFlag ?? "cloud"} (${r.route.reason})`);
      } catch (e) {
        console.error(err("pai worker: ") + (e instanceof Error ? e.message : String(e)));
        process.exitCode = 1;
      }
    });
}
