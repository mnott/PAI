import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkersConfig } from "./config.js";
import {
  computeInventory,
  inventoryRows,
  inventoryText,
  parseSizeMb,
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
  rssMb: async () => 21000,
});

const input = (over: Partial<InventoryInput> = {}): InventoryInput => ({
  providers,
  embedding: { backend: "ollama-f16", ollamaUrl: "http://127.0.0.1:11434", inProcessModel: "snowflake" },
  runtimes: [{ name: "strata", kind: "strata", url: "http://127.0.0.1:8035" }],
  consumers: [
    { name: "paperfull-llm", runtime: "ollama", model: "qwen3:8b" },
    { name: "paperfull-embed", runtime: "docker-model-runner", model: "multilingual-e5-base-gguf-f16" },
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
    expect(by["strata"]!.models[0]).toMatchObject({ model: "flash-next", kind: "coding", memoryMb: 21000 });
    // a DISABLED provider is not a user of anything: no runtime row for coder
    expect(by["coder"]).toBeUndefined();
    expect(inv.runtimes.some((r) => r.users.some((u) => u === "worker:coder"))).toBe(false);
    expect(by["ollama"]!.models.find((m) => m.model === "arctic-embed-m-v1.5-f16")).toMatchObject({ loaded: true, memoryMb: 600, usedBy: ["pai-embedding"] });
    expect(by["ollama"]!.models.find((m) => m.model === "qwen3:8b")).toMatchObject({ loaded: false, usedBy: ["paperfull-llm"] });
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

  it("hints at duplicate embedding runtimes", async () => {
    const inv = await computeInventory(input(), deps());
    expect(inv.duplicates.some((d) => d.startsWith("embedding runs on 2 runtimes: ollama") && d.includes("docker-model-runner"))).toBe(true);
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
  it("one table, running first, with the duplicates line", async () => {
    const inv = await computeInventory(input(), deps());
    const rows = inventoryRows(inv);
    expect(rows[0]!.slice(0, 2)).toEqual(["strata", "running"]);
    // the disabled provider left the table entirely: no stopped row for it
    expect(rows.some((r) => r[1] === "stopped")).toBe(false);
    const text = inventoryText(inv, (h, r) => [h, ...r].map((x) => x.join(" | ")).join("\n"));
    expect(text).toContain("runtime | status | model | kind | memory / on disk | used by | port");
    expect(text).toContain("strata | running | flash-next | coding | 20.5 GB | worker:flashnext-iq3 | 8035");
    // an installed-only model shows its size on disk, not "-"
    expect(text).toContain("qwen3:8b (installed) | chat | 4.7 GB | paperfull-llm | 11434");
    expect(text).toContain("duplicates: embedding runs on 2 runtimes");
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
