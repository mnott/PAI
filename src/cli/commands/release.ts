/**
 * `pai release` and the update half (`pai update`): behaviour lives in src/release.
 */

import { resolve } from "node:path";
import { CliError, OPT, type CommandDef } from "../define.js";
import { parseStep, runRelease } from "../../release/release.js";
import { formatUpdate, updatePackage, UpdateFailed } from "../../release/update.js";

const out = (s: string): void => void process.stdout.write(s + "\n");

export const releaseCmd: CommandDef = {
  name: "release",
  summary: "Cut a release: forge commit and tag, GitHub mirror, GitHub Release with the package",
  description:
    "One release flow, no npm registry. In the repo (default: the current directory) it refuses a dirty tree or a branch other than main, then: bumps the version (npm version --no-git-tag-version, plus scripts/sync-versions.mjs when the repo has one), builds, runs the unit tests (never browser suites), commits `chore: release <v>`, tags v<v>, pushes origin main + tags (the forge), triggers the forge push-mirror sync and waits until the tag shows on GitHub, packs the package with `npm pack` and creates the GitHub Release with `gh release create`, attaching `<name>.tgz` (stable name, for `releases/latest/download`) and the versioned file. Notes: the CHANGELOG section for the version, else the commit subjects since the previous tag. " +
    "Every step prints one line. `--from <step>` resumes after a failure (after `tag` it releases the v* tag on HEAD; refused when HEAD has none); `--skip mirror` makes the mirror step a no-op when the tag is already on GitHub, and without a forge token it says to sync the mirror in the forge UI and run `pai release --from mirror`. A failure stops with the step name and a `state:` line saying what is committed, tagged and pushed. The forge token comes from the env var named by config release.forgeTokenEnv; GitHub access is `gh`'s own login.",
  options: [
    { name: "repo", type: "string", value: "PATH", summary: "Repository to release (default: the current directory)" },
    { name: "bump", type: "string", value: "patch|minor|major|X.Y.Z", default: "patch", summary: "Version bump or an explicit version" },
    { name: "from", type: "string", value: "STEP", summary: "Resume at STEP (check bump build test commit tag push mirror pack release); after tag the v* tag on HEAD is released" },
    { name: "skip", type: "string", value: "mirror", summary: "Skip the mirror step when the tag is already on GitHub" },
    { ...OPT.dryRun, summary: "Print the plan, change nothing" },
  ],
  examples: ["pai release --dry-run", "pai release --from mirror", "pai release --from pack", "pai release --bump minor", "pai release --repo ~/code/app --bump 2.0.0"],
  seeAlso: ["pai update", "pai build mirror-sync"],
  run: async (ctx) => {
    let from, skip;
    try {
      from = typeof ctx.opts.from === "string" ? parseStep(ctx.opts.from, "from") : undefined;
      skip = typeof ctx.opts.skip === "string" ? [parseStep(ctx.opts.skip, "skip")] : undefined;
      if (skip && skip[0] !== "mirror") throw new Error("--skip: only mirror can be skipped");
    } catch (e) {
      throw new CliError((e as Error).message, "pai release --help");
    }
    const res = await runRelease(
      { repo: resolve(typeof ctx.opts.repo === "string" ? ctx.opts.repo : process.cwd()), bump: typeof ctx.opts.bump === "string" ? ctx.opts.bump : "patch", dryRun: ctx.dryRun, from, skip },
      { out },
    );
    return res.ok ? 0 : 1;
  },
};

export const updateCmd: CommandDef = {
  name: "update",
  summary: "Update PAI (or another package) to the latest GitHub Release",
  description:
    "Reads the installed version, asks the GitHub API for the latest release of the package's repository (package.json `repository`) and, when it is newer, runs `npm i -g <release package url>`. `--check` only reports. `--package aibroker` does the same for AIBroker or any other package installed with `npm i -g` from a release. Run `pai reload` afterwards. " +
    "`--source` is the old behaviour for a source checkout: pull, rebuild, restart the daemon.",
  options: [
    { name: "check", type: "boolean", default: false, summary: "Only report whether a newer release exists" },
    { name: "package", type: "string", value: "NAME", summary: "Package to update (default: pai)" },
    { name: "source", type: "boolean", default: false, summary: "Update a source checkout (git pull, build, restart the daemon)" },
  ],
  examples: ["pai update --check", "pai update", "pai update --package aibroker"],
  seeAlso: ["pai reload", "pai release"],
  run: async (ctx) => {
    try {
      const r = await updatePackage({ package: typeof ctx.opts.package === "string" ? ctx.opts.package : undefined, check: ctx.opts.check === true });
      out(formatUpdate(r));
      return 0;
    } catch (e) {
      if (e instanceof UpdateFailed) throw new CliError(e.message, "pai update --check");
      throw e;
    }
  },
};
