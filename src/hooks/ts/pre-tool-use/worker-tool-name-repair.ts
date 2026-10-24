#!/usr/bin/env node

/**
 * worker-tool-name-repair.ts — PreToolUse (*)
 *
 * Worker-only (PAI_WORKER=1): rewrites a dotted tool name whose last segment
 * names a known tool (`Glob.glob` → `Glob`, `Bash.Bash` → `Bash`); anything
 * else passes untouched. Only I/O here; the rule lives in
 * lib/tool-name-repair.ts. Each repair is logged one line to
 * ~/.pai/logs/workers/tool-repair.log. A no-op in interactive sessions.
 * Denies the "R" tool call in workers. Also maps parameter aliases (path → file_path, cmd → command, regex → pattern) and answers invented tool names (Git) with a directive.
 */

import { currentWorkerId } from "../../../workers/worker-id.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { paiHomePath } from "../../../config/pai-home.js";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { type PathRepairCtx, renderPathDeny, renderPathRepair, repairFilePath } from "../lib/file-path-repair.js";
import { renderRepair, repairToolName, type ToolNameRepairInput, reportToolDenial, renderToolDenial, inventedToolDirective, repairParams, renderParamRepair } from "../lib/tool-name-repair.js";

function logRepair(tail: string): void {
  try {
    const dir = paiHomePath("logs", "workers");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "tool-repair.log"),
      `${new Date().toISOString()}\tworker=${currentWorkerId(process.env, dir) ?? "-"}\t${tail}\n`,
    );
  } catch {
    // logging must never block the decision
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return "";
  }
}

function pathCtx(cwd: string): PathRepairCtx {
  let tracked: string[] | undefined;
  return {
    cwd,
    tracked: () => (tracked ??= git(cwd, ["ls-files"]).split("\n").filter(Boolean)),
    mainRoot: () => {
      const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
      return common ? dirname(common) : null;
    },
  };
}

async function main(): Promise<void> {
  let text = "";
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch {
    return;
  }
  if (!text.trim()) return;

  let input: ToolNameRepairInput;
  try {
    input = JSON.parse(text) as ToolNameRepairInput;
  } catch {
    return;
  }

  const denial = reportToolDenial(input, process.env);
  if (denial) {
    process.stdout.write(renderToolDenial(denial) + "\n");
    return;
  }

  const directive = inventedToolDirective(input, process.env);
  if (directive) {
    logRepair(`[model]\tinvented tool\t${input.tool_name}`);
    process.stdout.write(renderToolDenial(directive) + "\n");
    return;
  }

  const repair = repairToolName(input, process.env);
  const next = { ...input, tool_name: repair?.new ?? input.tool_name, tool_input: repair?.updatedInput ?? input.tool_input };
  const params = repairParams(next, process.env);

  const fixed = { ...next, tool_input: params?.updatedInput ?? next.tool_input };
  const pathFix = repairFilePath(fixed, process.env, pathCtx(input.cwd ?? process.cwd()));
  if (pathFix?.kind === "deny") {
    logRepair(`[model]\tpath deny\t${String(fixed.tool_input?.file_path)}`);
    process.stdout.write(renderPathDeny(pathFix) + "\n");
    return;
  }
  if (pathFix) {
    logRepair(`path-repair ${pathFix.rule} ${pathFix.from} -> ${pathFix.to}`);
    process.stdout.write(renderPathRepair(pathFix) + "\n");
    return;
  }

  if (!repair && !params) return;

  if (repair) {
    logRepair(`${repair.old}\t${repair.new}`);
  }
  if (params) {
    logRepair(`[model]\tparam alias\t${params.old}\t${params.new}`);
    process.stdout.write(renderParamRepair({ old: repair ? `${repair.old} ${params.old}` : params.old, new: repair ? `${repair.new} ${params.new}` : params.new, updatedInput: params.updatedInput }) + "\n");
  } else {
    process.stdout.write(renderRepair(repair!) + "\n");
  }
}

main().catch(() => process.exit(0));
