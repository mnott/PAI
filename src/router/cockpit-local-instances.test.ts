import { describe, expect, it } from "vitest";
import { WIN_CLOUD_JS } from "./cockpit-page/win/cards-cloud.js";
import { withInstances } from "./cockpit.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const gbm = (m: number) => (m / 1024).toFixed(1);
const GB = 1024 ** 3;
const fn = (name: string) => WIN_CLOUD_JS.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))![0];
const residentOf = new Function("gbm", `${fn("limResident")}\nreturn limResident;`)(gbm);
const server = new Function("esc", "gbm", "shortModel", "limResident", `${fn("limEngineHtml")}\n${fn("limServerHtml")}\nreturn limServerHtml;`)(esc, gbm, (s: string) => s, residentOf) as (l: unknown) => string;

const inst = (n: number, pid: number, rssMb: number, inflight = 0) => ({ id: `gyro-m#${n}`, port: 8034 + n, pid, state: "ready", inflight, rssMb });
const card = (instances: unknown[]) => ({ provider: "gyro-m", kind: "local", up: true, rssMb: 4800, weightsBytes: 87 * GB, tokensPerSec: 30, served: ["m"], instances });

describe("local servers card lists each instance", () => {
  it("two instances: two rows, each with its own stop target and resident memory; weights once", () => {
    const h = server(card([inst(1, 88106, 4800, 1), inst(2, 22403, 900)]));
    expect(h.match(/data-stop="[^"]+"/g)).toEqual(['data-stop="gyro-m#1"', 'data-stop="gyro-m#2"']);
    expect(h).toContain("pid 88106");
    expect(h).toContain(":8035");
    expect(h).toContain("pid 22403");
    expect(h).toContain(":8036");
    expect(h).toContain("resident 4.7 GB");
    expect(h).toContain("resident 0.9 GB");
    expect(h).toContain("1 in flight");
    expect(h).toContain("30 tok/s");
    expect(h.match(/shared, mapped/g)).toHaveLength(1);
    expect(h).toContain("87.0 GB (shared, mapped)");
  });

  it("engine version: a dim line under the model, with and without a version; also on the instance rows", () => {
    const withEng = server({ ...card([]), engineVersion: "0.1.48-metal", engineDir: "strata-pr" });
    expect(withEng).toContain('<div class="dim nw">engine 0.1.48-metal · strata-pr</div>');
    expect(withEng.indexOf("engine 0.1.48-metal")).toBeGreaterThan(withEng.indexOf("gyro-m"));
    expect(server(card([]))).not.toContain("engine ");
    const instEng = server({ ...card([inst(1, 88106, 4800)]), engineVersion: "0.1.49-metal", engineDir: "build-gyro3" });
    expect(instEng).toContain('<div class="dim nw">engine 0.1.49-metal · build-gyro3</div>');
    expect(instEng).toContain("87.0 GB (shared, mapped)");
    expect(instEng.indexOf("engine 0.1.49-metal")).toBeLessThan(instEng.indexOf("pid 88106"));
  });

  it("no instance rows: the aggregated entry as before", () => {
    const h = server(card([]));
    expect(h).not.toContain("data-stop");
    expect(h).toContain("resident 4.7 GB of 87.0 GB");
  });

  it("header stop reads 'stop all (N)' for several instances and 'stop' for one, posting all:true only for several", () => {
    expect(WIN_CLOUD_JS).toContain('"stop all ("+n+")":"stop"');
    expect(WIN_CLOUD_JS).toContain("{target:l,all:true,value:\"confirm\"}:{target:l}");
  });
});

describe("withInstances", () => {
  const rows = [
    { id: "gyro-m#1", model: "gyro-m", port: 8035, pid: 1, state: "ready", inflight: 0 },
    { id: "gyro-m#2", model: "gyro-m", port: 8036, pid: 2, state: "ready", inflight: 2 },
    { id: "other#1", model: "other", port: 8050, pid: 3, state: "ready", inflight: 0 },
  ];
  const rss = async (pid: number) => (pid === 1 ? 4800 : pid === 2 ? 900 : undefined);
  it("attaches each instance with the rss of its own pid to its provider only", async () => {
    const out = await withInstances([{ provider: "gyro-m", kind: "local" }, { provider: "claude", kind: "cloud" }] as never, rows, rss, (m) => m);
    expect(out[0]!.instances).toEqual([
      { id: "gyro-m#1", port: 8035, pid: 1, state: "ready", inflight: 0, rssMb: 4800 },
      { id: "gyro-m#2", port: 8036, pid: 2, state: "ready", inflight: 2, rssMb: 900 },
    ]);
    expect(out[1]!.instances).toBeUndefined();
  });
});
