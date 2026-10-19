import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorkersYamlText } from "./workers-config.js";
import { starterWorkersYamlText } from "./workers-config.js";
import { addProvider, describeCap, setProviderCap } from "./providers.js";
import { readWorkersSection } from "./config.js";

const dirs: string[] = [];
const saved = process.env.PAI_WORKERS_YAML;

function setup(): { yamlPath: string; jsonPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pai-cap-"));
  dirs.push(dir);
  const yamlPath = join(dir, "workers.yaml");
  process.env.PAI_WORKERS_YAML = yamlPath;
  writeWorkersYamlText(yamlPath, starterWorkersYamlText());
  const jsonPath = join(dir, "config.json");
  addProvider({ name: "cloudp", baseUrl: "https://cloudp.example.com", model: "m", configPath: jsonPath });
  addProvider({ name: "locp", baseUrl: "http://127.0.0.1:8123", model: "m", configPath: jsonPath });
  return { yamlPath, jsonPath };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (saved === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = saved;
});

describe("provider cap", () => {
  it("defaults: local 1, cloud unlimited, source default", () => {
    const { jsonPath } = setup();
    const { workers } = readWorkersSection(jsonPath);
    expect(describeCap(workers.providers.locp)).toEqual({ cap: 1, source: "default" });
    expect(describeCap(workers.providers.cloudp)).toEqual({ cap: undefined, source: "default" });
    expect(setProviderCap("locp", undefined, jsonPath).effective).toBe("cap 1 (default)");
    expect(setProviderCap("cloudp", undefined, jsonPath).effective).toBe("cap unlimited (default)");
  });

  it("sets, shows and unsets through workers.yaml", () => {
    const { yamlPath, jsonPath } = setup();
    expect(setProviderCap("locp", 2, jsonPath).effective).toBe("cap 2 (config)");
    expect(readFileSync(yamlPath, "utf8")).toMatch(/maxConcurrent: 2/);
    expect(setProviderCap("locp", undefined, jsonPath).effective).toBe("cap 2 (config)");
    expect(setProviderCap("cloudp", 4, jsonPath).effective).toBe("cap 4 (config)");
    expect(setProviderCap("locp", "default", jsonPath).effective).toBe("cap 1 (default)");
    expect(readFileSync(yamlPath, "utf8")).not.toMatch(/maxConcurrent: 2/);
    expect(readFileSync(yamlPath, "utf8")).toMatch(/maxConcurrent: 4/);
  });

  it("rejects invalid values and unknown providers without writing", () => {
    const { yamlPath, jsonPath } = setup();
    const before = readFileSync(yamlPath, "utf8");
    for (const bad of [0, -1, 1.5, NaN]) expect(() => setProviderCap("locp", bad, jsonPath)).toThrow(/>= 1/);
    expect(() => setProviderCap("nope", 2, jsonPath)).toThrow(/no provider named/);
    expect(readFileSync(yamlPath, "utf8")).toBe(before);
  });
});
