/** Step 17: Worker providers — subagents on configured providers. */

import { c, line, section, type Rl, promptYesNo, readConfigRaw } from "../utils.js";
import { installWorkers } from "../../../../workers/install.js";
import { readWorkersSection } from "../../../../workers/config.js";
import { describeProviders, setWorkersEnabled } from "../../../../workers/providers.js";

export async function stepWorkers(rl: Rl): Promise<Record<string, unknown>> {
  section("Step 17: Worker Providers (Optional)");

  const existing = readConfigRaw();
  const current = existing.workers as { enabled?: boolean; providers?: Record<string, unknown> } | undefined;

  if (current?.providers && Object.keys(current.providers).length > 0) {
    if (current.enabled !== false) {
      console.log(c.ok("Worker providers already configured. Running install to refresh shims…"));
      for (const l of installWorkers().lines) line(`  ${l}`);
    }
    return { workers: current };
  }

  line();
  line("  PAI can run every subagent (worker) on a provider: the built-in");
  line("  `anthropic` one (your logged-in claude CLI, Max plan, no API key) or any");
  line("  Anthropic-compatible endpoint you add later.");
  line();
  line("  `pai worker run` is the runner; ps / follow / replay watch the runs;");
  line("  the Agent tool is denied and rewritten to it while workers are on.");
  line();

  const wanted = await promptYesNo(rl, "Turn workers on now with the built-in anthropic provider?", true);
  if (!wanted) {
    line();
    console.log(c.ok("Skipping workers."));
    console.log(c.dim("  Later: pai worker on   (other providers: pai worker providers add <name> … — see docs/worker.md)"));
    return { workers: { enabled: false, providers: {}, classes: {} } };
  }

  setWorkersEnabled(true);
  const r = installWorkers();
  for (const l of r.lines) line(`  ${l}`);
  const { workers } = readWorkersSection();
  console.log(c.ok("Workers on — provider: anthropic (built-in, no API key written)."));
  for (const l of describeProviders(workers)) line(c.dim(`  ${l}`));
  return {};
}
