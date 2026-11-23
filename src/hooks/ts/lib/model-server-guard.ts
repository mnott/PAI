/**
 * model-server-guard.ts — sessions and workers never start local model
 * servers (incident 2026-10-19: a session went looking for how to start
 * a server while the running one was never considered). Only commands that
 * start a server process match; curl/ps/lsof probes, quoted text and port
 * numbers alone never do. PAI answers which
 * local model runs (lib/../workers/local-status.ts); the operator starts
 * servers. Pure: the hook entry passes the daemon's cached answer line.
 *
 * Launchers are matched at command position (after env assignments, nohup,
 * sudo, ...), so `grep vllm-mlx notes.md` or `echo ollama serve` is text and
 * passes; `sh -c '<cmd>'` payloads are checked too. PAI_ALLOW_MODEL_SERVER=1
 * in the process env, or as a leading assignment on the segment that starts the server, disables the guard.
 */

import { basename } from "node:path";
import { parseCommand } from "./worker-guard.js";

const SERVER_BINARIES = new Set([
  "vllm-mlx", "vllm", "mlx_lm.server", "llama-server", "llama-cpp-server", "sglang", "text-generation-launcher",
  "tabbyapi", "koboldcpp", "mlx_lm.server.py",
]);
/** Python modules that serve models (`python -m <module>`), matched by prefix. */
const SERVER_MODULES = /^(?:vllm(?:[.-]|$)|mlx_lm\.server|mlx_vlm\.server|llama_cpp\.server|sglang\.launch_server|tabbyapi|koboldcpp)/;
const PREFIXES = new Set(["nohup", "sudo", "exec", "env", "setsid", "time", "command", "caffeinate", "nice"]);
const SHELLS = new Set(["sh", "bash", "zsh", "source", "."]);
const LAUNCHER_SCRIPT = /(?:^|\/)(?:serve-[^/\s]*\.sh|(?:[^\s]*\/)?(?:model|strata|vllm|mlx|llama)[^\s]*\/run-[^/\s]*\.sh)$|(?:^|\/)strata\/serve\/server\.py$/;
/** `pai worker local` verbs that start nothing; start, scale and the deprecated `<tier>` alias do. */
const READ_ONLY_LOCAL = new Set(["status", "stop", "off", "help"]);
const MODEL_AGENT = /mlx|vllm|llama|ollama|strata|flashnext|model|local\d/i;

function isAssignment(w: string): boolean {
  return /^[A-Za-z_]\w*=/.test(w);
}

/** The segment opts in with a leading `PAI_ALLOW_MODEL_SERVER=1` assignment. */
function allowsServer(words: string[]): boolean {
  for (const w of words) {
    if (!isAssignment(w)) return false;
    if (/^PAI_ALLOW_MODEL_SERVER=["']?1["']?$/.test(w)) return true;
  }
  return false;
}

function startsServer(words: string[], depth: number): boolean {
  let i = 0;
  while (i < words.length && (isAssignment(words[i]) || PREFIXES.has(words[i]))) i++;
  const w = words.slice(i);
  if (!w.length) return false;
  const bin = basename(w[0]);
  if (SERVER_BINARIES.has(bin)) return true;
  if (bin === "ollama" && w[1] === "serve") return true;
  if ((bin === "lms" || bin === "lmstudio") && w[1] === "server") return true;
  if (bin === "sglang" || bin === "tabbyAPI") return true;
  if (bin === "strata" && (w[1] === "serve" || w[1] === "run")) return true;
  if (/^python[\d.]*$/.test(bin) && w[1] === "-m" && (SERVER_BINARIES.has(w[2] ?? "") || SERVER_MODULES.test(w[2] ?? ""))) return true;
  if (/^python[\d.]*$/.test(bin) && LAUNCHER_SCRIPT.test(w[1] ?? "")) return true;
  if (/^python[\d.]*$/.test(bin) && /(?:^|\/)server\.py$/.test(w[1] ?? "") && w.includes("--engine")) return true;
  if ((bin === "mtplx" || bin === "locals") && w[1] === "serve") return true;
  if (LAUNCHER_SCRIPT.test(w[0])) return true;
  if (SHELLS.has(bin)) {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined && depth < 3) {
      return parseCommand(w[c + 1]).some((s) => startsServer(s.words, depth + 1));
    }
    const script = w.slice(1).find((a) => !a.startsWith("-"));
    if (script && LAUNCHER_SCRIPT.test(script)) return true;
  }
  if (bin === "pai" && w[1] === "worker" && w[2] === "local") {
    const verb = w.slice(3).find((a) => !a.startsWith("-"));
    return verb !== undefined && !READ_ONLY_LOCAL.has(verb);
  }
  if (bin === "launchctl" && /^(load|kickstart|bootstrap|start)$/.test(w[1] ?? "")) {
    return w.slice(2).some((a) => MODEL_AGENT.test(a));
  }
  return false;
}

export function modelServerReason(command: string, env: Record<string, string | undefined>, answer: string): string | null {
  if (env.PAI_ALLOW_MODEL_SERVER === "1") return null;
  const starts = parseCommand(command).some((s) => !allowsServer(s.words) && startsServer(s.words, 0));
  if (!starts) return null;
  return (
    "Local model servers are not started by sessions unless asked for: add PAI_ALLOW_MODEL_SERVER=1 in front of the command to start it on purpose. " +
    `Running now: ${answer}. Use \`pai worker run --local\`.`
  );
}
