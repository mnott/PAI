/** `pai harness ...`: sessions PAI can read from agent harnesses (read-only). */

import { existsSync } from "node:fs";
import type { CommandDef, RunContext } from "../define.js";
import { ADAPTERS, enabledHarnessNames } from "../../harness/index.js";
import type { HarnessSession } from "../../harness/types.js";
import { maskSecrets } from "../../hooks/ts/lib/loop-guard.js";
import { dim, ok, renderTable, shortenPath } from "../lib/utils.js";

const fmt = (iso: string): string => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "—");

function sessionsFor(harness: string, cwd?: string): HarnessSession[] {
  const a = ADAPTERS.find((x) => x.name === harness);
  if (!a || !a.detect()) return [];
  return a.listSessions(cwd ? { cwd } : undefined);
}

function listCmd(opts: { json?: boolean }): number {
  const enabled = new Set(enabledHarnessNames());
  const rows = ADAPTERS.map((a) => {
    const detected = a.detect();
    return [
      a.name,
      detected ? ok("yes") : dim("no"),
      enabled.has(a.name) ? ok("yes") : dim("no"),
      detected ? String(sessionsFor(a.name).length) : dim("—"),
    ];
  });
  if (opts.json) {
    console.log(
      JSON.stringify(
        ADAPTERS.map((a) => ({
          adapter: a.name,
          detected: a.detect(),
          enabled: enabled.has(a.name),
          sessions: a.detect() ? sessionsFor(a.name).length : undefined,
        })),
        null,
        2
      )
    );
    return 0;
  }
  console.log(renderTable(["adapter", "detected", "enabled", "sessions"], rows));
  console.log(dim(`  enabled set comes from config key harness.adapters (pai config get harness.adapters)`));
  return 0;
}

function sessionsCmd(opts: { harness?: string; cwd?: string; json?: boolean }): number {
  const names = opts.harness ? [opts.harness] : enabledHarnessNames();
  const out: HarnessSession[] = [];
  for (const name of names) out.push(...sessionsFor(name, opts.cwd));
  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  if (!out.length) {
    console.log(dim(`  no sessions${opts.cwd ? ` under ${opts.cwd}` : ""} (${names.join(", ")})`));
    return 0;
  }
  console.log(
    renderTable(
      ["harness", "id", "updated", "cwd"],
      out.map((s) => [s.harness, s.id, fmt(s.updatedAt), s.cwd ? maskSecrets(shortenPath(s.cwd, 48)) : dim("—")])
    )
  );
  return 0;
}

export const harnessCommand: CommandDef = {
  name: "harness",
  summary: "Sessions PAI can read from agent harnesses (Claude Code, Codex, ...)",
  description:
    "Read-only ingestion of other harnesses' session logs. `list` shows each adapter: detected (its store exists), enabled (config key harness.adapters), and its session count. `sessions` lists the sessions themselves.",
  examples: ["pai harness list", "pai harness sessions", "pai harness sessions --harness codex --cwd ~/proj"],
  seeAlso: ["pai config get harness.adapters"],
  subcommands: [
    {
      name: "list",
      summary: "Each adapter: detected, enabled, session count",
      description: "One row per adapter PAI knows. Only enabled adapters whose store exists are ever read.",
      options: [{ name: "json", type: "boolean", default: false, summary: "Print JSON instead of a table" }],
      examples: ["pai harness list", "pai harness list --json"],
      run: (ctx: RunContext) => listCmd({ json: ctx.opts.json === true }),
    },
    {
      name: "sessions",
      summary: "List sessions, newest first",
      description: "Sessions of the enabled adapters (or one harness with --harness), optionally limited to one working directory.",
      options: [
        { name: "harness", type: "string", value: "NAME", summary: "Only this adapter (default: the enabled set)" },
        { name: "cwd", type: "string", value: "DIR", summary: "Only sessions of this working directory" },
        { name: "json", type: "boolean", default: false, summary: "Print JSON instead of a table" },
      ],
      examples: ["pai harness sessions", "pai harness sessions --harness codex", "pai harness sessions --cwd ~/proj"],
      run: (ctx: RunContext) => {
        const cwd = ctx.opts.cwd as string | undefined;
        if (cwd && !existsSync(cwd)) {
          console.log(dim(`  no such directory: ${cwd}`));
          return 0;
        }
        return sessionsCmd({ harness: ctx.opts.harness as string | undefined, cwd, json: ctx.opts.json === true });
      },
    },
  ],
};
