/** Step 16: Task bus — optional external tracker for cross-session work. */

import { c, line, section, type Rl, prompt, promptYesNo, readConfigRaw } from "../utils.js";
import { listProjects } from "../../../../tasks/providers/todoist.js";
import type { TaskConfig } from "../../../../tasks/types.js";

/** Shape of the `tasks` block as it sits in the raw config file. */
type RawTaskConfig = Partial<TaskConfig> & {
  providers?: { todoist?: { apiKey?: string; rootProjectId?: string; enabled?: boolean } };
};

export async function stepTaskBus(rl: Rl): Promise<Record<string, unknown>> {
  section("Step 16: Task Bus (Optional)");

  const existing = readConfigRaw();
  const current = (existing.tasks ?? {}) as RawTaskConfig;
  const todoist = current.providers?.todoist;

  if (todoist?.apiKey && todoist?.rootProjectId) {
    console.log(c.ok("Task bus already configured. Skipping."));
    return { tasks: current };
  }

  line();
  line("  The task bus lets any PAI session file work into a shared tracker, so a");
  line("  routine can pick it up later and hand it to the session that owns it.");
  line();
  line("  PAI works fully without this. Skip it unless you want cross-session tasks.");
  line();

  const wanted = await promptYesNo(rl, "Enable the task bus (requires a Todoist account)?", false);
  if (!wanted) {
    line();
    console.log(c.ok("Skipping the task bus."));
    console.log(c.dim("  Add later by re-running `pai setup`."));
    return { tasks: { enabled: false } };
  }

  // -- Token -----------------------------------------------------------------
  // Prefer an existing env token so the user need not paste a credential twice.
  // Never read it from ~/.claude.json: the Todoist MCP keeps one there, but that
  // belongs to a different tool and PAI must not scrape another program's secrets.
  line();
  line("  Get your API token from Todoist:");
  line(c.dim("    Settings -> Integrations -> Developer"));
  line(c.dim("    https://app.todoist.com/app/settings/integrations/developer"));
  line();
  line("  It grants full read/write access to your Todoist. Treat it like a password.");
  line();

  const envToken = process.env.TODOIST_API_KEY?.trim();
  let apiKey = todoist?.apiKey ?? "";

  if (!apiKey && envToken) {
    const useEnv = await promptYesNo(rl, "Found TODOIST_API_KEY in the environment. Use it?", true);
    if (useEnv) apiKey = envToken;
  }

  while (!apiKey) {
    apiKey = (await prompt(rl, "  Paste your Todoist API token: ")).trim();
    if (!apiKey) console.log(c.warn("  A token is required, or answer no to skip the task bus."));
  }

  // -- Root project ----------------------------------------------------------
  // Listing projects doubles as token validation: a bad token fails here, at
  // setup time, rather than silently returning nothing during a morning routine.
  line();
  line("  Fetching your Todoist projects...");

  let projects: Array<{ id: string; name: string }>;
  try {
    projects = await listProjects(apiKey);
  } catch (e) {
    line();
    console.log(c.warn(`Could not reach Todoist: ${e instanceof Error ? e.message : String(e)}`));
    console.log(c.dim("  The token may be wrong, or the network is unavailable."));
    console.log(c.dim("  Saved nothing. Re-run `pai setup` to try again."));
    return { tasks: { enabled: false } };
  }

  if (projects.length === 0) {
    console.log(c.warn("  No projects found. Create one in Todoist first, then re-run setup."));
    return { tasks: { enabled: false } };
  }

  line();
  line("  Which project should hold the bus? Create a dedicated one if unsure.");
  line();
  projects.forEach((p, i) => line(`    ${String(i + 1).padStart(2)}. ${p.name}`));
  line();

  let rootProjectId = "";
  while (!rootProjectId) {
    const answer = (await prompt(rl, `  Project number [1-${projects.length}]: `)).trim();
    const idx = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < projects.length) {
      rootProjectId = projects[idx]!.id;
    } else {
      console.log(c.warn(`  Enter a number between 1 and ${projects.length}.`));
    }
  }

  const chosen = projects.find((p) => p.id === rootProjectId)!;

  // The ID is stored, never the name. Todoist's project search silently returns
  // zero results for names containing emoji, so resolving by name later would
  // report "no tasks" instead of failing — the exact silent failure this
  // subsystem exists to surface.
  line();
  console.log(c.ok(`Task bus enabled on "${chosen.name}" (id ${rootProjectId}).`));
  console.log(c.dim("  Label a task `pai:<project>` to assign it to a PAI project."));
  console.log(c.dim("  Only projects with an alias can be dispatched to — see `pai project name`."));

  const autoDispatch = await promptYesNo(
    rl,
    "Automatically hand tasks to the owning session (needs AIBroker)?",
    false,
  );

  return {
    tasks: {
      enabled: true,
      autoDispatch,
      providers: {
        todoist: { enabled: true, apiKey, rootProjectId },
      },
    },
  };
}
