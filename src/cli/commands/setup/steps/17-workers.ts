/** Step 17: Worker providers — subagents on configured providers. */

import { c, line, section, type Rl, promptYesNo, readConfigRaw } from "../utils.js";
import { installWorkers } from "../../../../workers/install.js";

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
  line("  PAI can run every subagent (worker) on a provider you configure —");
  line("  a non-Anthropic endpoint via its Anthropic-compatible API.");
  line();
  line("  `pai worker run` is the runner; ps / follow / replay watch the runs;");
  line("  the Agent tool is denied and rewritten to it once providers exist.");
  line();
  line("  PAI works fully without this — Agent subagents then just run as before.");
  line();

  const wanted = await promptYesNo(rl, "Configure a worker provider now?", false);
  if (!wanted) {
    line();
    console.log(c.ok("Skipping worker providers."));
    console.log(c.dim("  Add later: pai worker providers add <name> … — see docs/worker.md"));
    return { workers: { enabled: false, providers: {}, roles: {} } };
  }

  line();
  line("  Add the provider after setup finishes (this step only prepares the");
  line("  wiring — shims, hook registration, log dir):");
  line();
  line(c.dim("    pai worker providers add glm \\"));
  line(c.dim("      --base-url https://api.example.com/api/anthropic \\"));
  line(c.dim("      --key-file ~/.config/example/api_key \\"));
  line(c.dim("      --model example-4.7 --fast-model example-4.7-flash"));
  line();
  line("  The first provider turns workers on and seeds the roles.");
  line();

  const r = installWorkers();
  for (const l of r.lines) line(`  ${l}`);
  return { workers: { enabled: false, providers: {}, roles: {} } };
}
