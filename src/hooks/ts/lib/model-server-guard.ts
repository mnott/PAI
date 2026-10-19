/**
 * model-server-guard.ts — sessions and workers never start local model
 * servers and never port-scan for them (incident 2026-10-19: a session curled
 * 127.0.0.1:8010/8011/8020, found nothing, and went looking for how to start
 * a server while the running one was never considered). PAI answers which
 * local model runs (lib/../workers/local-status.ts); the operator starts
 * servers. Pure: the hook entry passes the daemon's cached answer line.
 *
 * Launchers are matched at command position (after env assignments, nohup,
 * sudo, ...), so `grep vllm-mlx notes.md` or `echo ollama serve` is text and
 * passes; `sh -c '<cmd>'` payloads are checked too. PAI_ALLOW_MODEL_SERVER=1
 * (set by the operator in their shell, never by PAI) disables the guard.
 */

import { basename } from "node:path";
import { parseCommand } from "./worker-guard.js";
import { dropHeredocBodies } from "./heredoc.js";

const SERVER_BINARIES = new Set(["vllm-mlx", "vllm", "mlx_lm.server", "llama-server", "llama-cpp-server"]);
const PREFIXES = new Set(["nohup", "sudo", "exec", "env", "setsid", "time", "command", "caffeinate", "nice"]);
const SHELLS = new Set(["sh", "bash", "zsh", "source", "."]);
const LAUNCHER_SCRIPT = /(?:^|\/)(?:run|serve)-[^/\s]*\.sh$/;
const MODEL_AGENT = /mlx|vllm|llama|ollama|strata|flashnext|model|local\d/i;

function isAssignment(w: string): boolean {
  return /^[A-Za-z_]\w*=/.test(w);
}

function startsServer(words: string[], depth: number): boolean {
  let i = 0;
  while (i < words.length && (isAssignment(words[i]) || PREFIXES.has(words[i]))) i++;
  const w = words.slice(i);
  if (!w.length) return false;
  const bin = basename(w[0]);
  if (SERVER_BINARIES.has(bin)) return true;
  if (bin === "ollama" && w[1] === "serve") return true;
  if (bin === "strata" && (w[1] === "serve" || w[1] === "run")) return true;
  if (/^python[\d.]*$/.test(bin) && w[1] === "-m" && SERVER_BINARIES.has(w[2] ?? "")) return true;
  if (LAUNCHER_SCRIPT.test(w[0])) return true;
  if (SHELLS.has(bin)) {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined && depth < 3) {
      return parseCommand(w[c + 1]).some((s) => startsServer(s.words, depth + 1));
    }
    const script = w.slice(1).find((a) => !a.startsWith("-"));
    if (script && LAUNCHER_SCRIPT.test(script)) return true;
  }
  if (bin === "launchctl" && /^(load|kickstart|bootstrap|start)$/.test(w[1] ?? "")) {
    return w.slice(2).some((a) => MODEL_AGENT.test(a));
  }
  return false;
}

/** Two or more distinct loopback ports in 8000-8099 probed by one command, or a loop over a port variable. */
function isPortScan(raw: string): boolean {
  const command = dropHeredocBodies(raw);
  if (!/\b(curl|wget|nc|ncat|nmap)\b/.test(command)) return false;
  const ports = new Set<string>();
  for (const m of command.matchAll(/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(80\d\d)\b/g)) ports.add(m[1]);
  if (ports.size >= 2) return true;
  const viaVar = /(?:127\.0\.0\.1|localhost|\[::1\]):\$\{?\w+/.test(command);
  const range = /\bseq\s+80\d\d\b|\{80\d\d\.\.80\d\d\}|\bfor\s+\w+\s+in\s+(?:[^;\n]*\b80\d\d\b[^;\n]*\b80\d\d\b)/.test(command);
  return viaVar && range;
}

export function modelServerReason(command: string, env: Record<string, string | undefined>, answer: string): string | null {
  if (env.PAI_ALLOW_MODEL_SERVER === "1") return null;
  const starts = parseCommand(command).some((s) => startsServer(s.words, 0));
  if (!starts && !isPortScan(command)) return null;
  return (
    "Local model servers are started by the operator, not by sessions. " +
    `Running now: ${answer}. Use \`pai worker run --local\`.`
  );
}
