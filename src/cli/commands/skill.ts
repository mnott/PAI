/** `pai skill ...`: how skills are used. */

import { OPT, type CommandDef } from "../define.js";
import { skillTelemetryCmd } from "../lib/skill.js";

export const skillCommand: CommandDef = {
  name: "skill",
  summary: "How your skills are used",
  description: "Skills are reusable instructions a session can load. `pai skill telemetry` shows which ones were triggered and when.",
  examples: ["pai skill telemetry", "pai skill telemetry --status active --json"],
  seeAlso: ["pai audit skills"],
  subcommands: [
    {
      name: "telemetry",
      summary: "Which skills were used, when, and where",
      description: "Lists skills with their trigger counts, last use and projects. Output with --json is the raw data.",
      options: [
        { name: "scope", type: "string", value: "NAME", default: "default", summary: "Governance scope to read" },
        { name: "status", type: "string", value: "STATE", summary: "Only skills in this state: trial, active or archived" },
        { name: "limit", type: "number", value: "N", default: 50, summary: "Maximum rows" },
        { ...OPT.json, summary: "Output raw JSON" },
      ],
      examples: ["pai skill telemetry", "pai skill telemetry --status trial --limit 10", "pai skill telemetry --json"],
      seeAlso: ["pai audit skills"],
      run: (ctx) => skillTelemetryCmd({
        scope: ctx.opts.scope as string | undefined,
        status: ctx.opts.status as string | undefined,
        limit: ctx.opts.limit as number | undefined,
        json: ctx.opts.json === true,
      }),
    },
  ],
};
