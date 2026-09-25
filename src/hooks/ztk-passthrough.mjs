#!/usr/bin/env node
/**
 * ztk-passthrough — decide whether a Bash command's output should skip
 * ztk's rewrite/compaction step.
 *
 * ztk compacts aggressively and is lossy for short, already-structured
 * output: a plain `ls` came back with a file misreported as a directory,
 * and `wc -l ... | tail -1` came back summarised instead of verbatim.
 * Interpreters, text-processing tools, anything already piped through
 * head/tail/wc, and anything asking for machine-readable JSON output must
 * keep their exact stdout, so they bypass ztk entirely.
 * Git is included because compaction turned a failing git commit into a
 * bare "ok" — its stderr and exit codes are essential and must survive.
 *
 * Prints "yes" (pass through, skip ztk) or "no" (send to ztk) to stdout.
 */

const PASSTHROUGH_COMMANDS = new Set([
  "ls", "wc", "echo", "printf", "pwd", "which", "whoami", "date",
  "basename", "dirname", "readlink", "stat", "du", "df",
  "head", "tail", "cat", "jq", "sed", "awk", "sort", "uniq", "tr", "cut",
  "true", "test", "[",
  "git",
  "python3", "node", "bun",
]);

const LAST_STAGE_PASSTHROUGH = new Set(["head", "tail", "wc"]);

const VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/;
const CD_PREFIX = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/;
const ENV_PREFIX = /^env\s+/;
const TIMEOUT_PREFIX = /^timeout\s+\S+\s+/;

/** Strip leading `cd … &&`, `env …`, `timeout N`, and variable assignments, in any order. */
function stripLeaders(command) {
  let cur = command.trimStart();
  for (let i = 0; i < 20; i++) {
    const before = cur;
    cur = cur.replace(CD_PREFIX, "").replace(ENV_PREFIX, "").replace(TIMEOUT_PREFIX, "").replace(VAR_ASSIGN, "");
    cur = cur.trimStart();
    if (cur === before) break;
  }
  return cur;
}

function firstWord(command) {
  return command.trim().split(/\s+/)[0] ?? "";
}

function lastPipelineStage(command) {
  const stages = command.split("|");
  return stages[stages.length - 1] ?? "";
}

export function shouldPassThrough(rawCommand) {
  const command = rawCommand ?? "";
  if (!command.trim()) return false;

  if (command.includes("--output-format json") || command.includes("--json")) return true;

  const lastStageFirstWord = firstWord(lastPipelineStage(command));
  if (LAST_STAGE_PASSTHROUGH.has(lastStageFirstWord)) return true;

  const stripped = stripLeaders(command);
  const head = firstWord(stripped);
  return PASSTHROUGH_COMMANDS.has(head);
}

function main() {
  const command = process.argv[2] ?? "";
  console.log(shouldPassThrough(command) ? "yes" : "no");
}

main();
