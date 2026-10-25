/** `pai rules ...`: the PreToolUse security rules and their fixtures. */

import { type CommandDef, type RunContext } from "../define.js";
import { listRules, projectRuleDirs, allRuleDirs } from "../../hooks/ts/lib/rules/load.js";
import { lintRules } from "../../hooks/ts/lib/rules/lint.js";
import { renderTable, ok, warn, err } from "../lib/utils.js";

function listCmd(json: boolean): number {
  const { rules, errors, ignored } = listRules(allRuleDirs(process.cwd()), { projectDirs: projectRuleDirs(process.cwd()) });
  if (json) {
    console.log(JSON.stringify({ rules, errors, ignored }, null, 2));
    return 0;
  }
  console.log(
    renderTable(
      ["id", "severity", "source", "enabled"],
      rules.map((r) => [r.id, r.severity, r.source, r.severity === "off" ? "off" : "on"]),
    ),
  );
  for (const e of errors) console.log(err(`load error: ${e}`));
  for (const i of ignored) console.log(warn(`ignored: ${i}`));
  return 0;
}

function lintCmd(json: boolean): number {
  const { rules, errors } = listRules(allRuleDirs(process.cwd()), { projectDirs: projectRuleDirs(process.cwd()) });
  const enabled = rules.filter((r) => r.severity !== "off");
  const lints = lintRules(enabled);
  const failed = lints.filter((l) => !l.ok);
  if (json) {
    console.log(JSON.stringify({ lints, errors }, null, 2));
    return failed.length || errors.length ? 1 : 0;
  }
  for (const l of lints) {
    if (l.ok) continue;
    console.log(err(`✖ ${l.id}`));
    for (const f of l.failures) console.log(`  ${f}`);
  }
  for (const e of errors) console.log(err(`load error: ${e}`));
  if (!failed.length && !errors.length) {
    console.log(ok(`✔ ${enabled.length} rules, fixtures pass`));
    return 0;
  }
  return 1;
}

export const rulesCommand: CommandDef = {
  name: "rules",
  summary: "Security rules: list them, lint their fixtures",
  description:
    "The PreToolUse security rules. Built-ins ship with the package; user rules live in PAI_HOME/rules or .pai/rules " +
    "as *.rule.yaml files — a user rule with a built-in's id replaces it, severity: off disables it.",
  examples: ["pai rules list", "pai rules lint"],
  seeAlso: ["pai audit tokens hooks"],
  subcommands: [
    {
      name: "list",
      summary: "Every rule with severity, source and enabled state",
      description: "One row per rule id; a disabled (severity: off) rule shows as off.",
      options: [{ name: "json", type: "boolean", default: false, summary: "Machine-readable JSON output" }],
      examples: ["pai rules list", "pai rules list --json"],
      run: (ctx: RunContext) => listCmd(ctx.opts.json === true),
    },
    {
      name: "lint",
      summary: "Run every rule's fixtures; exit 1 on a failure or load error",
      description: "Each rule's tests.match strings must hit and tests.no_match strings must not. Load errors count as failures.",
      options: [{ name: "json", type: "boolean", default: false, summary: "Machine-readable JSON output" }],
      examples: ["pai rules lint", "pai rules lint --json"],
      run: (ctx: RunContext) => lintCmd(ctx.opts.json === true),
    },
  ],
};
