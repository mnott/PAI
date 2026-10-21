import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { parse } from "yaml";
import { paiHomePath } from "../config/pai-home.js";
import { findModelPath, parseLocalConfig, parseServers, planStart, stopLine, LocalTierError } from "./local-tiers.js";

const YAML = `
local_tiers:
  small:
    provider: ornith
    model: /models/ornith-4bit
    served: ornith-1.5-35b
    port: 8013
  medium:
    provider: ornith6
    model: /models/ornith-6bit
  large:
    provider: local
    model: /models/coder-next
    flags: --max-num-seqs 1
`;
const providers = {
  ornith: { url: "http://127.0.0.1:8013", model: "ornith-1.5-35b" },
  ornith6: { url: "http://127.0.0.1:8015", model: "ornith-1.5-35b-6bit" },
  local: { url: "http://127.0.0.1:8010", model: "qwen3-coder-next" },
};

describe("local tiers", () => {
  const cfg = parseLocalConfig(parse(YAML), providers);

  it("parses tiers, deriving port and served name from the provider", () => {
    expect(cfg.tiers.small.port).toBe(8013);
    expect(cfg.tiers.medium).toMatchObject({ port: 8015, served: "ornith-1.5-35b-6bit" });
    expect(cfg.tiers.large.flags).toEqual(["--max-num-seqs", "1"]);
  });

  it("rejects a tier without a derivable port", () => {
    expect(() => parseLocalConfig({ local_tiers: { x: { provider: "nope", model: "/m", served: "s" } } }, {}))
      .toThrow(LocalTierError);
  });

  it("small start line equals the routing-chain recipe", () => {
    const h = homedir();
    const C =
      "--host 127.0.0.1 --continuous-batching --enable-prefix-cache --cache-memory-mb 8000 --gpu-memory-utilization 0.30 " +
      "--chunked-prefill-tokens 4096 --max-num-seqs 3 --max-request-tokens 131072 --max-tokens 32768 " +
      "--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3";
    const expected =
      `PF_FORCE_TEXT=1 nohup ${h}/.local/share/uv/tools/vllm-mlx/bin/python ` +
      `${h}/.local/share/vllm-mlx-serve/serve_patched_fold_text.py serve /models/ornith-4bit ` +
      `--served-model-name ornith-1.5-35b --port 8013 ${C} ` +
      `--default-chat-template-kwargs '{"enable_thinking": false}' > ${paiHomePath("logs", "local", "ornith.log")} 2>&1 < /dev/null &`;
    expect(planStart(cfg, cfg.tiers.small).line).toBe(expected);
    expect(stopLine(cfg)).toBe("for p in $(pgrep -f serve_patched); do kill $p; done");
  });

  it("maps running servers to tiers by port and ignores unrelated processes", () => {
    const ps = [
      "101 4194304 python serve_patched_fold_text.py serve /m --served-model-name a --port 8013 --host x",
      "102 100 pgrep -f serve_patched",
    ].join("\n");
    const s = parseServers(ps, cfg, 1);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ pid: 101, tier: "small", provider: "ornith", rssKb: 4194304 });
  });
});

describe("findModelPath", () => {
  const dirs = [
    { name: "Qwen3-Coder-30B-A3B-Instruct-MLX-4bit", path: "/a" },
    { name: "Qwen3.6-35B-A3B-4bit", path: "/b" },
  ];
  it("matches the served name ignoring case and punctuation", () => {
    expect(findModelPath("qwen3-coder-30b", dirs)).toBe("/a");
    expect(findModelPath("qwen3.6-35b", dirs)).toBe("/b");
  });
  it("null when not installed", () => expect(findModelPath("devstral-small-2", dirs)).toBeNull());
});
