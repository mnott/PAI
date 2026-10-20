import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { activeTier, parseLocalConfig, parseServers, planStart, stopLines, tierButtons, LocalTierError } from "./local-tiers.js";

const dir = mkdtempSync(join(tmpdir(), "pai-tiers-"));
mkdirSync(join(dir, "serve"));
writeFileSync(join(dir, "serve/server.py"), "");
writeFileSync(join(dir, "gyro.json"), JSON.stringify({ exe: join(dir, "build/strata"), cwd: dir }));
writeFileSync(join(dir, "iq3.json"), JSON.stringify({ exe: join(dir, "park/strata") }));

const YAML = `
local_tiers:
  gyro-m: { engine: strata, label: "Gyro-M (Strata)", provider: gyro-m, config: ${dir}/gyro.json, port: 8035, memoryGb: 40 }
  iq3s: { engine: strata, label: "Flash-Next IQ3_S (Strata)", provider: flashnext-iq3, config: ${dir}/iq3.json, port: 8035, memoryGb: 60, python: /opt/py/bin/python }
  coder-next: { engine: script, label: "Coder-Next 4bit (vllm-mlx)", provider: codernext4, start: /srv/serve-8034.sh, port: 8034, memoryGb: 45 }
  old: { provider: local, model: /models/coder, served: coder, port: 8010 }
`;
const providers = {
  "gyro-m": { url: "http://127.0.0.1:8035", model: "qwen3.8-flash-next-gyro-m" },
  "flashnext-iq3": { url: "http://127.0.0.1:8035", model: "flash-next-iq3" },
  codernext4: { url: "http://127.0.0.1:8034", model: "coder-next-4bit" },
};
const cfg = parseLocalConfig(parse(YAML), providers);

describe("tier engines", () => {
  it("parses engine, label, memory; vllm-mlx stays the default", () => {
    expect(cfg.tiers["gyro-m"]).toMatchObject({ engine: "strata", label: "Gyro-M (Strata)", memoryGb: 40, served: "qwen3.8-flash-next-gyro-m", strataDir: dir });
    expect(cfg.tiers["gyro-m"].python).toBe(join(homedir(), "strata/.venv/bin/python"));
    expect(cfg.tiers.iq3s.python).toBe("/opt/py/bin/python");
    expect(cfg.tiers.iq3s.strataDir).toBe(dir);
    expect(cfg.tiers["coder-next"]).toMatchObject({ engine: "script", start: "/srv/serve-8034.sh" });
    expect(cfg.tiers.old).toMatchObject({ engine: "vllm-mlx", label: "old" });
  });

  it("requires config for strata and start for script", () => {
    expect(() => parseLocalConfig({ local_tiers: { x: { engine: "strata", provider: "p", port: 1 } } }, {})).toThrow(LocalTierError);
    expect(() => parseLocalConfig({ local_tiers: { x: { engine: "script", provider: "p", port: 1 } } }, {})).toThrow(LocalTierError);
    expect(() => parseLocalConfig({ local_tiers: { x: { engine: "foo", provider: "p", port: 1 } } }, {})).toThrow(/engine/);
  });

  it("dry-run lines per engine", () => {
    const g = planStart(cfg, cfg.tiers["gyro-m"]).line;
    expect(g).toMatch(new RegExp(`^cd ${dir} && nohup ${homedir()}/strata/.venv/bin/python serve/server.py --engine strata --config ${dir}/gyro.json --port 8035 > .*/logs/local/gyro-m.log 2>&1 < /dev/null &$`));
    expect(planStart(cfg, cfg.tiers["coder-next"]).line).toMatch(/^nohup \/bin\/bash \/srv\/serve-8034.sh > .*\/logs\/local\/coder-next.log 2>&1 < \/dev\/null &$/);
    expect(planStart(cfg, cfg.tiers.old).line).toContain("serve_patched_fold_text.py serve /models/coder");
    expect(planStart(cfg, cfg.tiers["gyro-m"]).readyMs).toBe(5 * 60 * 1000);
  });

  it("stop lines cover vllm-mlx, Strata and script ports", () => {
    const l = stopLines(cfg);
    expect(l).toContain("for p in $(pgrep -f serve_patched); do kill $p; done");
    expect(l.some((x) => x.includes("serve/server.py --engine strata"))).toBe(true);
    expect(l.some((x) => x.includes(`${dir}/build/strata --serve`))).toBe(true);
    expect(l).toContain("for p in $(lsof -nP -iTCP:8034 -sTCP:LISTEN -t); do kill $p; done");
  });

  it("finds every kind of running server", () => {
    const ps = [
      `11 300 ${homedir()}/strata/.venv/bin/python serve/server.py --engine strata --config ${dir}/gyro.json --port 8035`,
      `12 52000000 ${dir}/build/strata --serve --pack /p`,
      "13 4000000 python serve_patched_fold_text.py serve /m --served-model-name a --port 8010",
      "14 4500000 /usr/bin/python3 -m something",
      "15 100 pgrep -f serve_patched",
    ].join("\n");
    const s = parseServers(ps, cfg, 1, { 8034: [14] });
    expect(s.map((x) => [x.pid, x.tier])).toEqual([[11, "gyro-m"], [12, "gyro-m"], [13, "old"], [14, "coder-next"]]);
    expect(s[3].rssKb).toBe(4500000);
  });

  it("the active tier is the one whose port answers with its model name", async () => {
    const ans = (port: number) => Promise.resolve(port === 8035 ? ["flash-next-iq3"] : null);
    expect((await activeTier(cfg, ans))?.tier).toBe("iq3s");
    expect(await activeTier(cfg, () => Promise.resolve(null))).toBeNull();
  });

  it("tier buttons carry label and memory", () => {
    expect(tierButtons(cfg)[0]).toEqual({ tier: "gyro-m", label: "Gyro-M (Strata)", memoryGb: 40 });
  });
});
