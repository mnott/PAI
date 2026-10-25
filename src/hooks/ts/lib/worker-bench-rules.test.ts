import { describe, it, expect } from "vitest";
import { decideWorkerGuard, type WorkerGuardContext } from "./worker-guard.js";
import { BENCH_DENY_REASON } from "./worker-bench-rules.js";

const ctx: WorkerGuardContext = { cwd: "/work/wt/a", home: "/home/u", worktreeRoot: "/work/wt/a", inWorktree: true, mainCheckout: "/work/main", testScript: () => "vitest" };
const SB = "~/.cache/pai/strata-bench";
const run = (command: string, env: Record<string, string> = {}) =>
  decideWorkerGuard({ tool_name: "Bash", tool_input: { command } }, { PAI_WORKER: "1", ...env }, () => ctx);

const DENIED = [
  `${SB}/r3/run.sh`,
  `zsh ${SB}/r3/run.sh --round 2`,
  `source ${SB}/r3/run.sh`,
  `. ${SB}/r2/lib.sh && source ${SB}/r3/run.sh`,
  `nohup ${SB}/r3/hcap3.sh &`,
  `${SB}/eval/evalset.sh`,
  `bash ${SB}/eval/realset.sh`,
  `${SB}/r3/coder-l-smoke.sh`,
  `cd ${SB}/r3 && ./run.sh`,
  `python3 -I ${SB}/bench.py`,
  `python3 cache_ttft.py`,
  `uv run cascade.py`,
  `python3 serve/server.py --port 8035`,
  `pai models start coder-l`,
  `pai models stop`,
  `pai local gyro start`,
  `pai local stop`,
  `kill $(lsof -ti :8035)`,
  `kill -9 $(lsof -ti:8035)`,
  `bash -c 'source ${SB}/r3/run.sh'`,
  `PAI_BENCH_GO=1 ${SB}/r3/run.sh`,
  // 2026-10-25 incident: detached CPU inference via a diag script
  `cd ${SB}/diag; nohup sh -c './01-fork-cpu-oracle.sh > 01.out 2>&1; echo $? > 01.rc' > /dev/null 2>&1 & echo $! > 01.pid`,
  `cd ${SB}/diag && sh -c './x.sh'`,
  `${SB}/diag/anything.sh`,
  `llama-completion -m x.gguf`,
  `/opt/homebrew/bin/llama-cli -m x.gguf -t 16`,
  `llama-server -m x.gguf`,
  `llama-bench -m x.gguf`,
  `/path/strata --pack p --tokens 1`,
  `nohup strata --pack p &`,
  `ollama run qwen`,
  `ollama serve`,
  `ollama pull qwen`,
  `mlx_lm.generate --model m`,
  `python3 -m mlx_lm.server --model m`,
  `python -m mlx_lm generate`,
  `vllm serve m`,
  `vllm-mlx serve m`,
  `bash -c "llama-perplexity -m x.gguf"`,
  `nohup sh -c 'time /path/strata --pack p'`,
];

describe("benchmark and model-server guard", () => {
  for (const c of DENIED) {
    it(`denies without the flag: ${c}`, () => {
      const d = run(c);
      expect(d.decision).toBe("deny");
      expect((d as { reason?: string }).reason).toBe(BENCH_DENY_REASON);
    });
    if (!c.startsWith("PAI_BENCH_GO=")) {
      it(`allows with PAI_BENCH_GO=1: ${c}`, () => {
        expect(run(c, { PAI_BENCH_GO: "1" }).decision).toBe("allow");
      });
    }
  }
  for (const c of [
    `${SB}/r3/run.sh --dry-run`,
    `zsh ${SB}/r3/run.sh --dry-run`,
    `zsh -n ${SB}/r3/run.sh`,
    `bash -n ${SB}/r3/coder-l-smoke.sh`,
    `${SB}/r3/coder-l-smoke.sh --dry-run`,
    `grep -n run.sh README.md`,
    `grep -rn "source .*run.sh" ${SB}`,
    `cat ${SB}/r3/run.sh`,
    `pai models list`,
    `pai worker run --local -p x`,
    `lsof -ti :8035`,
    `ls ${SB}/diag`,
    `cat ${SB}/diag/01.out`,
    `grep -n strata README.md`,
    `echo llama-cli`,
    `ollama list`,
    `llama-completion --dry-run -m x.gguf`,
    `pip install mlx_lm`,
  ]) {
    it(`allows without the flag: ${c}`, () => {
      expect(run(c).decision).toBe("allow");
    });
  }
  it("is a no-op outside workers", () => {
    expect(decideWorkerGuard({ tool_name: "Bash", tool_input: { command: `${SB}/r3/run.sh` } }, {}, () => ctx).decision).toBe("allow");
  });
});
