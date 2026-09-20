/**
 * `pai worker capability` — which provider(s) serve a capability across the
 * whole config (workers.yaml's `capabilities:` map), distinct from `pai
 * worker model` which sets a model id on one provider's own `models` table.
 *
 * No args: lists every configured preference and what it resolves to right
 * now. `capability <name> <provider>[,<provider>…]` sets a preference list
 * (first usable one wins, see `resolveCapability`). `capability <name>
 * --unset` removes it.
 */

import type { Command } from "commander";
import {
  describeCapabilities,
  setCapabilityPreference,
  unsetCapabilityPreference,
} from "../../../workers/providers.js";
import { readWorkersSection } from "../../../workers/config.js";
import { ok, err } from "../../utils.js";

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(err("pai worker: ") + msg);
  process.exitCode = 1;
}

export function registerWorkerCapabilityCommand(workerCmd: Command): void {
  workerCmd
    .command("capability [name] [providers]")
    .description(
      "Which provider(s) serve a capability (e.g. image), independent of any one\n" +
        "provider's own model table: no args lists every preference and what it\n" +
        "resolves to; `capability <name> <provider>[,<provider>…]` sets the\n" +
        "preference list (first usable one wins); `capability <name> --unset`\n" +
        "removes it. An `engine: image` provider preferred for \"image\" runs\n" +
        "`pai worker run --capability image` directly against its images API."
    )
    .option("--unset", "Remove the preference for <name>")
    .option("--json", "Machine-readable output")
    .action(
      (name: string | undefined, providers: string | undefined, opts: { unset?: boolean; json?: boolean }) => {
        try {
          if (name === undefined) {
            const { workers } = readWorkersSection();
            const lines = describeCapabilities(workers);
            if (opts.json) {
              console.log(JSON.stringify(lines));
            } else {
              for (const line of lines) console.log(`  ${line}`);
            }
            return;
          }
          if (opts.unset) {
            unsetCapabilityPreference(name);
            console.log(ok(`removed the capability preference for "${name}"`));
            return;
          }
          if (providers === undefined) {
            throw new Error(
              `usage: pai worker capability ${name} <provider>[,<provider>…]  (or --unset to remove it)`
            );
          }
          const workers = setCapabilityPreference(name, providers.split(",").map((p) => p.trim()));
          const line = describeCapabilities(workers).find((l) => l.startsWith(`${name}:`));
          console.log(ok(`${name}: [${workers.capabilities[name]?.join(", ")}]`));
          if (line) console.log(`  -> ${line.split(" -> ")[1]}`);
        } catch (e) {
          fail(e);
        }
      }
    );
}
