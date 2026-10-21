import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkersConfig } from "./config.js";
import {
  computeInventory,
  ProbeHold,
  inventoryRows,
  inventoryText,
  parseSizeMb,
  parseFootprint,
  processTreeMemory,
  processTreeRssMb,
  parseTable,
  readInventory,
  writeInventory,
  type InventoryDeps,
  type InventoryInput,
} from "./model-inventory.js";

const prov = (baseUrl: string, model: string, enabled = true) => ({
  enabled,
  protocol: "anthropic" as const,
  baseUrl,
  keyFile: null,
  env: {},
  models: { default: model, fast: model },
});

const providers = {
  cloud: prov("https://api.example.invalid", "c"),
  "flashnext-iq3": prov("http://127.0.0.1:8035", "flash-next"),
  coder: prov("http://127.0.0.1:8034", "coder-next", false),
} as unknown as WorkersConfig["providers"];

const DOCKER_LS = [
  "MODEL NAME                                                     PARAMETERS  QUANTIZATION    ARCHITECTURE  MODEL ID      CREATED        CONTEXT  SIZE        ",
  "huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16    277.45M     MOSTLY_F16      bert          70764c485211  7 months ago   512      530.18MiB   ",
  "qwen3:8B-Q4_K_M                                                8.19 B      IQ2_XXS/Q4_K_M  qwen3         79fa56c07429  17 months ago           4.68 GiB    ",
].join("\n");
const DOCKER_PS = [
  "MODEL NAME                                                   BACKEND    MODE       UNTIL  ",
  "huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16  llama.cpp  embedding  4m  ",
].join("\n");

const deps = (over: Partial<Record<string, unknown>> = {}): InventoryDeps => ({
  getJson: async (url) => {
    if (url in over) return over[url];
    if (url === "http://127.0.0.1:8035/v1/models") return { data: [{ id: "flash-next" }] };
    if (url === "http://127.0.0.1:11434/api/ps") return { models: [{ name: "arctic-embed-m-v1.5-f16", size: 600 * 1048576 }] };
    if (url === "http://127.0.0.1:11434/api/tags") return { models: [{ name: "arctic-embed-m-v1.5-f16", size: 600 * 1048576 }, { name: "qwen3:8b", size: 5_000_000_000 }] };
    return null;
  },
  run: async (_c, args) => (args[1] === "ls" ? DOCKER_LS : args[1] === "ps" ? DOCKER_PS : "Docker Model Runner is running\n"),
  memory: async () => ({ footprintMb: 21000, mappedMb: 90000 }),
});

const input = (over: Partial<InventoryInput> = {}): InventoryInput => ({
  providers,
  embedding: { backend: "ollama-f16", ollamaUrl: "http://127.0.0.1:11434", inProcessModel: "snowflake" },
  runtimes: [{ name: "strata", kind: "strata", url: "http://127.0.0.1:8035" }],
  consumers: [
    { name: "paperfull-chat", runtime: "ollama", model: "qwen3:8b", label: "Paperfull chat" },
    { name: "paperfull-embed", runtime: "docker-model-runner", model: "multilingual-e5-base-gguf-f16", label: "Paperfull search" },
  ],
  ...over,
});

describe("parsers", () => {
  it("parses docker model ls columns and sizes", () => {
    const rows = parseTable(DOCKER_LS);
    expect(rows.map((r) => r["MODEL NAME"])).toEqual(["huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16", "qwen3:8B-Q4_K_M"]);
    expect(rows[1]!["SIZE"]).toBe("4.68 GiB");
    expect(parseSizeMb("598.63MiB")).toBe(599);
    expect(parseSizeMb("4.68 GiB")).toBe(4792);
  });
});

describe("processTreeRssMb", () => {
  // ps -axo pid=,ppid=,rss= output: a thin python listener (30 MB) whose engine
  // child (50 GB) holds the model; the listener's own RSS says nothing
  const PS = [
    "    1     0    9000",
    "  500     1    1200",
    "  501   500     29000", // listener: the python server
    "  502   501  51000000", // engine child: the model
    "  503   502    200000", // grandchild
    "  600     1    99000", // unrelated process
  ].join("\n");
  const run = async (_c: string, args: string[]) => (args[0] === "-axo" ? PS : null);

  it("sums the RSS of the listener's whole process tree", async () => {
    expect(await processTreeRssMb("501", run)).toBe(Math.round((29000 + 51000000 + 200000) / 1024));
  });

  it("ignores processes outside the tree; a bare listener is its own RSS", async () => {
    expect(await processTreeRssMb("600", run)).toBe(Math.round(99000 / 1024));
    expect(await processTreeRssMb("1", run)).toBe(Math.round((9000 + 1200 + 29000 + 51000000 + 200000 + 99000) / 1024));
  });

  it("survives a reparented cycle and missing ps output", async () => {
    const cyc = "1 1 100\n2 1 200\n1 2 100"; // pid 1 listed as its own descendant
    expect(await processTreeRssMb("1", async () => cyc)).toBe(Math.round(300 / 1024));
    expect(await processTreeRssMb("1", async () => null)).toBe(0);
  });
});

describe("computeInventory", () => {
  it("lists providers, ollama and docker with models, memory and users", async () => {
    const inv = await computeInventory(input(), deps());
    const by = Object.fromEntries(inv.runtimes.map((r) => [r.name, r]));
    expect(by["flashnext-iq3"]).toBeUndefined();
    expect(by["strata"]).toMatchObject({ status: "running", port: 8035, users: ["worker:flashnext-iq3"] });
    expect(by["strata"]!.models[0]).toMatchObject({ model: "flash-next", kind: "coding", memoryMb: 21000, mappedMb: 90000 });
    // a DISABLED provider is not a user of anything: no runtime row for coder
    expect(by["coder"]).toBeUndefined();
    expect(inv.runtimes.some((r) => r.users.some((u) => u === "worker:coder"))).toBe(false);
    expect(by["ollama"]!.models.find((m) => m.model === "arctic-embed-m-v1.5-f16")).toMatchObject({ loaded: true, memoryMb: 600, usedBy: ["pai-embedding"] });
    expect(by["ollama"]!.models.find((m) => m.model === "qwen3:8b")).toMatchObject({ loaded: false, usedBy: ["paperfull-chat"], label: "Paperfull chat" });
    const dmr = by["docker-model-runner"]!;
    expect(dmr.status).toBe("running");
    expect(dmr.models.find((m) => m.loaded)!.usedBy).toEqual(["paperfull-embed"]);
  });

  it("carries the size on disk per installed model (ollama tags `size`, docker ls SIZE)", async () => {
    const inv = await computeInventory(input(), deps());
    const by = Object.fromEntries(inv.runtimes.map((r) => [r.name, r]));
    expect(by["ollama"]!.models.find((m) => m.model === "qwen3:8b")).toMatchObject({ loaded: false, sizeMb: 4768 });
    expect(by["ollama"]!.models.find((m) => m.model === "arctic-embed-m-v1.5-f16")!.sizeMb).toBe(600);
    expect(by["docker-model-runner"]!.models.find((m) => m.model === "qwen3:8B-Q4_K_M")!.sizeMb).toBe(4792);
  });

  it("no duplicates hint for different models on two runtimes — only the same model id counts", async () => {
    const inv = await computeInventory(input(), deps());
    // ollama (arctic-embed, qwen3:8b) + docker (e5, qwen3) serve different ids: no hint
    expect(inv.duplicates).toEqual([]);
    // the same model id loaded on two running runtimes: one hint naming the id
    const dup = await computeInventory(input({ consumers: [] }), {
      ...deps(),
      getJson: async (url) =>
        url === "http://127.0.0.1:8035/v1/models"
          ? { data: [{ id: "arctic-embed-m-v1.5-f16" }] }
          : url === "http://127.0.0.1:11434/api/ps"
            ? { models: [{ name: "arctic-embed-m-v1.5-f16", size: 600 * 1048576 }] }
            : url === "http://127.0.0.1:11434/api/tags"
              ? { models: [{ name: "arctic-embed-m-v1.5-f16", size: 600 * 1048576 }] }
              : null,
      run: async () => null,
    });
    expect(dup.duplicates).toEqual(["arctic-embed-m-v1.5-f16 runs on 2 runtimes: strata + ollama — consider consolidating"]);
  });

  it("a disabled provider behind a declared endpoint keeps that endpoint unlisted", async () => {
    const off = { "flashnext-iq3": prov("http://127.0.0.1:8035", "flash-next", false) } as unknown as WorkersConfig["providers"];
    const inv = await computeInventory(input({ providers: off }), deps());
    expect(inv.runtimes.some((r) => r.port === 8035)).toBe(false);
    expect(inv.runtimes.some((r) => r.name === "strata")).toBe(false);
  });

  describe("local tiers", () => {
    const tiers = [
      { provider: "coder", label: "Coder-Next 4bit" },
      { provider: "flashnext-iq3", label: "Flash-Next" },
    ];
    const t = (over: Record<string, unknown>) => ({ ...deps({ "http://127.0.0.1:8035/v1/models": null, ...over }) });

    it("the active tier has a card although its provider is disabled; the other tier is simply not running", async () => {
      const inv = await computeInventory(input({ tiers, runtimes: [] }), t({ "http://127.0.0.1:8034/v1/models": { data: [{ id: "coder-next" }] } }));
      const active = inv.runtimes.find((r) => r.port === 8034)!;
      expect(active).toMatchObject({ status: "running" });
      const other = inv.runtimes.find((r) => r.port === 8035)!;
      expect(other.status).toBe("stopped");
      expect(other).not.toHaveProperty("inactive");
      expect(other.enabled).toBe(true);
    });

    it("a disabled tier that is down is listed grey while another tier is active, unlisted otherwise", async () => {
      const flashUp = { "http://127.0.0.1:8035/v1/models": { data: [{ id: "flash-next" }] } };
      const on = await computeInventory(input({ tiers, runtimes: [] }), { ...deps(flashUp) });
      const stopped = on.runtimes.find((r) => r.port === 8034)!;
      expect(stopped).toMatchObject({ status: "stopped", enabled: true });
      expect(stopped).not.toHaveProperty("inactive");
      const off = await computeInventory(input({ tiers, runtimes: [] }), t({}));
      expect(off.runtimes.some((r) => r.port === 8034)).toBe(false);
    });

    it("an expected tier that is down with no tier running stays a failure", async () => {
      const inv = await computeInventory(input({ tiers, runtimes: [] }), t({}));
      const flash = inv.runtimes.find((r) => r.port === 8035)!;
      expect(flash.status).toBe("stopped");
      expect(flash).not.toHaveProperty("inactive");
    });
  });

  it("tolerates no docker and no ollama", async () => {
    const inv = await computeInventory(input({ consumers: [] }), { ...deps(), getJson: async () => null, run: async () => null });
    expect(inv.runtimes.find((r) => r.name === "docker-model-runner")).toBeUndefined();
    expect(inv.runtimes.find((r) => r.name === "ollama")!.status).toBe("stopped");
    expect(inv.duplicates).toEqual([]);
  });

  it("shows the in-process embedder when the backend is not ollama", async () => {
    const inv = await computeInventory(input({ embedding: { backend: "transformers-cpu-q8", ollamaUrl: "http://127.0.0.1:11434", inProcessModel: "snowflake" } }), deps());
    expect(inv.runtimes.find((r) => r.kind === "in-process")!.models[0]).toMatchObject({ model: "snowflake", usedBy: ["pai-embedding"] });
  });
});

describe("render and cache", () => {
  it("one table, running first, with no duplicates line for different models", async () => {
    const inv = await computeInventory(input(), deps());
    const rows = inventoryRows(inv);
    expect(rows[0]!.slice(0, 2)).toEqual(["strata", "running"]);
    // the disabled provider left the table entirely: no stopped row for it
    expect(rows.some((r) => r[1] === "stopped")).toBe(false);
    const text = inventoryText(inv, (h, r) => [h, ...r].map((x) => x.join(" | ")).join("\n"));
    expect(text).toContain("runtime | status | model | label | kind | memory / on disk | used by | port");
    expect(text).toContain("strata | running | flash-next | - | coding | 20.5 GB (+87.9 GB file mapped) | worker:flashnext-iq3 | 8035");
    // an installed-only model shows its size on disk, not "-"; the consumer label is the purpose
    expect(text).toContain("qwen3:8b (installed) | Paperfull chat | chat | 4.7 GB | paperfull-chat | 11434");
    expect(text).not.toContain("duplicates:");
  });

  it("the label column shows models.labels (runtime label, model label wins)", () => {
    const mk = (model: string, loaded: boolean) => ({ model, kind: "chat" as const, loaded, usedBy: [] });
    const inv = {
      at: "x",
      duplicates: [],
      runtimes: [
        { name: "ollama", kind: "ollama", status: "running", models: [mk("qwen3:8b", true)], users: [] },
        { name: "strata", kind: "strata", status: "running", models: [mk("flash-next", true)], users: [] },
      ],
    } as never;
    const rows = inventoryRows(inv as never, { ollama: { "qwen3:8b": "cheap drafts" }, strata: "coding engine" });
    expect(rows.map((r) => r[3])).toEqual(["cheap drafts", "coding engine"]);
    expect(inventoryRows(inv as never).map((r) => r[3])).toEqual(["-", "-"]);
  });

  it("loaded models sort first, installed-only after, stopped runtimes last", () => {
    const mk = (model: string, loaded: boolean) => ({ model, kind: "chat" as const, loaded, usedBy: [] });
    const rows = inventoryRows({
      at: "x",
      duplicates: [],
      runtimes: [
        { name: "stopped-rt", kind: "ollama", status: "stopped", models: [], users: [] },
        { name: "idle-rt", kind: "docker-model-runner", status: "idle", models: [mk("idle-m", false)], users: [] },
        { name: "live-rt", kind: "ollama", status: "running", models: [mk("cold-m", false), mk("hot-m", true)], users: [] },
      ],
    } as never);
    expect(rows.map((r) => r[0] + ":" + r[2])).toEqual(["live-rt:hot-m", "live-rt:cold-m (installed)", "idle-rt:idle-m (installed)", "stopped-rt:-"]);
  });

  it("cache round-trips while fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-"));
    const inv = await computeInventory(input(), deps(), new Date(1_000_000));
    expect(readInventory(dir)).toBeNull();
    writeInventory(dir, inv);
    expect(readInventory(dir, 1_000_000 + 30_000)).toEqual(inv);
    expect(readInventory(dir, 1_000_000 + 91_000)).toBeNull();
  });
});

const FOOTPRINT = [
  "strata [23438]: 64-bit    Footprint: 26 GB (16384 bytes per page)",
  "  Dirty      Clean  Reclaimable    Regions    Category",
  "    ---        ---          ---        ---    ---",
  " 120 MB        0 B          0 B        142    Untagged",
  "    0 B      70 GB          0 B         15    mapped file",
].join("\n");

describe("footprint", () => {
  it("parses own footprint and the mapped file separately", () => {
    expect(parseFootprint(FOOTPRINT)).toEqual({ footprintMb: 26624, mappedMb: 71680 });
    expect(parseFootprint("Footprint: 8193 KB (x)")).toEqual({ footprintMb: 8 });
    expect(parseFootprint("nothing")).toBeUndefined();
  });
  it("sums the tree", async () => {
    const run = async (c: string, a: string[]) => (c === "ps" ? "1 0\n10 1\n11 10\n99 1" : a[0] === "11" ? FOOTPRINT : a[0] === "10" ? "x: Footprint: 100 MB (p)" : null);
    expect(await processTreeMemory("10", run)).toEqual({ footprintMb: 26724, mappedMb: 71680 });
  });
});

describe("status from what is loaded", () => {
  const run = (ps: string) => async (_c: string, a: string[]) => (a[1] === "ls" ? DOCKER_LS : a[1] === "ps" ? ps : "Docker Model Runner is running\n");
  const EMPTY_PS = "MODEL NAME  BACKEND  MODE  UNTIL  \n";
  it("runner up, nothing loaded: idle, installed", async () => {
    const inv = await computeInventory(input(), { ...deps(), run: run(EMPTY_PS) });
    const dmr = inv.runtimes.find((r) => r.name === "docker-model-runner")!;
    expect(dmr.status).toBe("idle");
    expect(dmr.models.every((m) => !m.loaded)).toBe(true);
    const text = inventoryText(inv, (h, r) => [h, ...r].map((x) => x.join(" | ")).join("\n"));
    expect(text).toContain("docker-model-runner | available (loads on first request) | huggingface.co/keisuke-miyako/multilingual-e5-base-gguf-f16 (installed)");
  });
  it("one model loaded: running", async () => {
    const inv = await computeInventory(input(), { ...deps(), run: run(DOCKER_PS) });
    expect(inv.runtimes.find((r) => r.name === "docker-model-runner")!.status).toBe("running");
  });
  it("runner down: stopped", async () => {
    const inv = await computeInventory(input(), { ...deps(), run: async (_c, a) => (a[1] === "ls" ? DOCKER_LS : "Docker Model Runner is not running") });
    expect(inv.runtimes.find((r) => r.name === "docker-model-runner")!.status).toBe("stopped");
  });
});

describe("consumers by served model id", () => {
  it("a provider whose model is not served is 'not served', not a user", async () => {
    const two = {
      "gyro-m": prov("http://127.0.0.1:8035", "gyro-id"),
      "flashnext-iq3": prov("http://127.0.0.1:8035", "iq3-id"),
    } as unknown as WorkersConfig["providers"];
    const d = { ...deps(), getJson: async (u: string) => (u === "http://127.0.0.1:8035/v1/models" ? { data: [{ id: "gyro-id" }] } : null) };
    const inv = await computeInventory(input({ providers: two, runtimes: [], consumers: [] }), d);
    const rt = inv.runtimes.find((r) => r.port === 8035)!;
    expect(rt.models[0]!.usedBy).toEqual(["worker:gyro-m"]);
    expect(rt.users).toEqual(["worker:gyro-m"]);
    expect(rt.notServed).toEqual(["worker:flashnext-iq3"]);
    const text = inventoryText(inv, (h, r) => [h, ...r].map((x) => x.join(" | ")).join("\n"));
    expect(text).toContain("worker:gyro-m, worker:flashnext-iq3 (not served)");
  });
});

describe("probe hold", () => {
  const strata = (rts: Awaited<ReturnType<typeof computeInventory>>) => rts.runtimes.find((r) => r.port === 8035)!;
  const missing = (refused = false): InventoryDeps => ({ ...deps({ "http://127.0.0.1:8035/v1/models": null }), refused: () => refused });

  it("one failed probe keeps a running runtime up, marked slow, with its last good models", async () => {
    const hold = new ProbeHold();
    const ok = strata(await computeInventory(input(), deps(), new Date(), hold));
    expect(ok.status).toBe("running");
    const held = strata(await computeInventory(input(), missing(), new Date(), hold));
    expect(held.status).toBe("running");
    expect(held.slow).toBe(true);
    expect(held.models.map((m) => m.model)).toEqual(ok.models.map((m) => m.model));
  });
  it("three consecutive failed probes read down; a good probe in between resets the count", async () => {
    const hold = new ProbeHold();
    await computeInventory(input(), deps(), new Date(), hold);
    expect(strata(await computeInventory(input(), missing(), new Date(), hold)).status).toBe("running");
    expect(strata(await computeInventory(input(), missing(), new Date(), hold)).status).toBe("running");
    expect(strata(await computeInventory(input(), missing(), new Date(), hold)).status).toBe("stopped");
    await computeInventory(input(), deps(), new Date(), hold);
    await computeInventory(input(), missing(), new Date(), hold);
    const again = strata(await computeInventory(input(), missing(), new Date(), hold));
    expect(again.status).toBe("running");
    expect(again.slow).toBe(true);
  });
  it("a refused connection is down at once", async () => {
    const hold = new ProbeHold();
    await computeInventory(input(), deps(), new Date(), hold);
    expect(strata(await computeInventory(input(), missing(true), new Date(), hold)).status).toBe("stopped");
  });
  it("a runtime never seen up is down on the first miss, and without a hold nothing is held", async () => {
    expect(strata(await computeInventory(input(), missing(), new Date(), new ProbeHold())).status).toBe("stopped");
    expect(strata(await computeInventory(input(), missing())).status).toBe("stopped");
  });
});
