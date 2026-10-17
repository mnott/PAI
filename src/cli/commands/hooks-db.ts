import type { Command } from "commander";
import { getRegistryBackend } from "../../storage/factory.js";
import { runSessionStopHook, runPreCompactHook } from "../../cli2/commands/hooks-db.js";
export { runSessionStopHook, runPreCompactHook } from "../../cli2/commands/hooks-db.js";

export function registerHooksDbCommands(hooksDbCmd: Command): void {
  hooksDbCmd
    .command("session-stop <projectSlug>")
    .description("Internal: session-stop hook registry update (called by src/hooks/session-stop.sh)")
    .action(async (projectSlug: string) => {
      try {
        const backend = await getRegistryBackend();
        await runSessionStopHook(backend, projectSlug);
      } catch {
        // never surface a failure to the calling hook script
      }
    });

  hooksDbCmd
    .command("pre-compact <projectSlug>")
    .description("Internal: pre-compact hook registry update (called by src/hooks/pre-compact.sh)")
    .action(async (projectSlug: string) => {
      try {
        const backend = await getRegistryBackend();
        await runPreCompactHook(backend, projectSlug);
      } catch {
        // never surface a failure to the calling hook script
      }
    });
}
