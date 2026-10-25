/**
 * worker-bench-rules.ts — a worker must not start a benchmark or touch the shared local model servers.
 *
 * Incident 2026-10-24: a worker whose spec said "no server start/stop, no benchmark" sourced a strata-bench
 * run.sh and started a real rep. Prose in a spec is not enforcement. Benchmark and model-server commands
 * need the operator's go: PAI_BENCH_GO=1 in the worker's environment, set only by the operator's own start
 * command. An inline `PAI_BENCH_GO=1 cmd` assignment is a prefix the parser strips, so it never counts.
 */

export const BENCH_DENY_REASON =
  "benchmark and model-server commands need the operator's go (PAI_BENCH_GO=1 is set only by the operator's start command)";

const BENCH_PY = /^(bench|cache_ttft|cascade)\.py$/;
const SERVER_PY = /(^|\/)serve\/server\.py$/;
const INTERPRETERS = /^(bash|sh|zsh|source|\.|python[\d.]*|uv|uvx)$/;
const MODEL_PORT = /(lsof|:)\s*[^;&|\n]*\b803\d\b/;

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

const MLX_LM = /^mlx_lm(\.|$)/;

/** Model-runtime binaries (the one list): llama.cpp tools, the strata engine, ollama, mlx_lm, vllm. `cmd` is already basename'd by the prefix stripping. */
function isModelRuntime(cmd: string, args: string[]): boolean {
  const b = base(cmd);
  if (/^llama-/.test(b) || b === "strata" || MLX_LM.test(b)) return true;
  const pos = args.filter((a) => !a.startsWith("-"));
  if (b === "ollama") return /^(run|serve|pull)$/.test(pos[0] ?? "");
  if (b === "vllm" || b === "vllm-mlx") return pos[0] === "serve";
  if (/^python[\d.]*$/.test(b)) {
    const m = args.indexOf("-m");
    return m >= 0 && MLX_LM.test(args[m + 1] ?? "");
  }
  return false;
}

/** Whether `target` names a benchmark driver or model server script; `where` (cwd + raw command) resolves a bare `run.sh`, whose directory the prefix stripping drops. */
function isBenchTarget(target: string, where: string): boolean {
  const b = base(target);
  if (BENCH_PY.test(b) || SERVER_PY.test(target)) return true;
  if (b === "coder-l-smoke.sh") return true;
  if (b.endsWith(".sh")) return target.includes("strata-bench") || where.includes("strata-bench");
  return false;
}

/** Deny reason for one segment (prefix-stripped `cmd` + `args`), null when it is not a bench/model-server start. */
export function benchStartReason(cmd: string, args: string[], cwd: string, raw: string): string | null {
  const where = `${cwd} ${raw}`;
  const dry = args.some((a) => a === "--dry-run");
  const syntaxOnly = args.some((a) => a === "-n");
  const pos = args.filter((a) => !a.startsWith("-"));

  if (cmd === "pai") {
    if (pos[0] === "models" && /^(start|stop)$/.test(pos[1] ?? "")) return BENCH_DENY_REASON;
    if (pos[0] === "local" && pos.slice(1).some((a) => a === "start" || a === "stop")) return BENCH_DENY_REASON;
    return null;
  }
  if (cmd === "kill" && MODEL_PORT.test(raw) && /lsof/.test(raw)) return BENCH_DENY_REASON;

  if (dry || syntaxOnly) return null;
  if (isModelRuntime(cmd, args) || isBenchTarget(cmd, where)) return BENCH_DENY_REASON;
  if (INTERPRETERS.test(cmd)) {
    // `uv run x.py`, `python3 -I x.py`: the first non-flag word after the interpreter (and `run`) is the script
    const script = pos.find((a) => a !== "run");
    if (script && isBenchTarget(script, where)) return BENCH_DENY_REASON;
  }
  return null;
}
