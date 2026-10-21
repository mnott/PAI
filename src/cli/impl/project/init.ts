/** pai project init — thin wrapper over session/project-setup. */
import { err } from "../../lib/utils.js";
import { formatCheck, initProject, projectChecks, type InitOpts } from "../../../session/project-setup.js";

export async function cmdInit(opts: InitOpts): Promise<void> {
  try {
    const r = initProject(process.cwd(), opts);
    console.log(`project: ${r.root} (origin: ${r.origin}, sink: ${r.sink})`);
    for (const k of r.kept) console.log(`kept ${k} (exists; --force overwrites)`);
    for (const m of r.message) console.log(m);
    // a dry run writes nothing, so checking would only report the missing files again
    if (opts.dryRun) return;
    console.log();
    for (const c of await projectChecks(r.root, { env: process.env })) console.log(formatCheck(c));
  } catch (e) {
    console.error(err("pai project init: ") + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}
