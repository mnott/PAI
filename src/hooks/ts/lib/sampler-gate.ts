/**
 * sampler-gate.ts — the decision behind the PreToolUse Bash sampler gate.
 *
 * Pure, same split as sleep-poll-gate.ts. Denies a command that RUNS a
 * system-monitor sampler (mactop, htop, btop, glances, asitop, or powermetrics
 * with a sampling interval). Each of them wakes the SoC at a fixed rate; the
 * cockpit once spawned `mactop --headless` every few seconds. The same numbers
 * come from direct sources (sysctl, vm_stat, ioreg, pmset). A mention as text
 * (grep, echo, a commit message, which/man) is not a run.
 */

import { parseCommand } from "./worker-guard.js";

export interface SamplerGateInput {
  tool_name?: string;
  tool_input?: { command?: string };
}

export const SAMPLER_BINARIES = ["mactop", "htop", "btop", "glances", "asitop"] as const;

export const SAMPLER_REASON =
  "system samplers are blocked (mactop, htop, btop, glances, asitop, powermetrics with an interval): they wake the SoC at a fixed rate. " +
  "Read the direct sources once instead: `sysctl` (cpu, memory, load), `vm_stat`, `ioreg -r -d 1 -c IOAccelerator` (GPU), `pmset -g batt` / `pmset -g therm` (power, thermal).";

const WRAPPERS = new Set(["sudo", "env", "xargs", "nice", "nohup", "time", "command", "exec", "caffeinate", "taskpolicy", "arch", "timeout", "stdbuf", "watch", "doas"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** First sampler a word list runs, or null. Wrapper words and their flags are skipped; `sh -c` payloads are scanned. */
function samplerIn(ws: string[], depth = 0): string | null {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (i > 0 && (/^-/.test(w) || /^\d+$/.test(w)) && WRAPPERS.has(base(ws[i - 1]))) ) i++;
    else if (WRAPPERS.has(base(w))) i++;
    else if (i > 0 && /^-/.test(w)) i++; // flags of a wrapper chain
    else break;
  }
  const cmd = ws[i];
  if (cmd === undefined) return null;
  const name = base(cmd);
  if ((SAMPLER_BINARIES as readonly string[]).includes(name)) return name;
  if (name === "powermetrics") {
    const rest = ws.slice(i + 1);
    if (rest.some((a) => /^(-i|-n)\d*$/.test(a) || /^--sample-rate(=|$)/.test(a) || /^--sample-count(=|$)/.test(a))) return "powermetrics";
    return null;
  }
  if (SHELLS.has(name) && depth < 3) {
    const c = ws.indexOf("-c", i + 1);
    if (c >= 0 && ws[c + 1] !== undefined) return samplerInCommand(ws[c + 1], depth + 1);
  }
  return null;
}

function samplerInCommand(command: string, depth = 0): string | null {
  for (const seg of parseCommand(command)) {
    const hit = samplerIn(seg.words, depth);
    if (hit) return hit;
  }
  return null;
}

export function decideSamplerGate(input: SamplerGateInput): { decision: "allow" } | { decision: "deny"; reason: string } {
  if (input.tool_name && input.tool_name !== "Bash") return { decision: "allow" };
  const command = input.tool_input?.command;
  if (typeof command !== "string") return { decision: "allow" };
  const hit = samplerInCommand(command);
  return hit ? { decision: "deny", reason: `${hit} blocked: ${SAMPLER_REASON}` } : { decision: "allow" };
}
