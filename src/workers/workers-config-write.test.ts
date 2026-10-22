import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkersYamlText,
  effectiveWorkersYamlData,
  readWorkersYaml,
  writeWorkersYaml,
  writeWorkersYamlText,
} from "./workers-config.js";

const dirs: string[] = [];
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pai-wcw-"));
  dirs.push(d);
  return d;
};
const savedYamlEnv = process.env.PAI_WORKERS_YAML;
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedYamlEnv === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYamlEnv;
});

const USER = `local: gyro
providers:
  gyro:
    url: http://127.0.0.1:8080
    models:
      default: gyro-m
`;

describe("writeWorkersYaml keeps the user's own document", () => {
  it("an edited tier keeps the `local` placeholder and unedited tiers stay raw", () => {
    const dir = newDir();
    const yamlPath = join(dir, "workers.yaml");
    process.env.PAI_WORKERS_YAML = yamlPath;
    writeFileSync(yamlPath, USER);
    const data = effectiveWorkersYamlData(yamlPath);
    const t2 = data.tiers.find((t) => t.id === "t2")!;
    expect(t2.models[0]).toBe("gyro"); // resolved in memory
    t2.models = [...t2.models, "anthropic/haiku"];
    writeWorkersYaml(yamlPath, data);
    const text = readFileSync(yamlPath, "utf8");
    expect(text).toContain("local: gyro");
    expect(text).toMatch(/- local\n/);
    expect(text).not.toMatch(/^\s+- gyro\s*$/m);
    expect(text).toContain("anthropic/haiku");
    // the round trip still resolves the placeholder
    const back = effectiveWorkersYamlData(yamlPath);
    expect(back.tiers.find((t) => t.id === "t2")!.models[0]).toBe("gyro");
  });
});

describe("buildWorkersYamlText", () => {
  it("emits a tier's escalation", () => {
    const dir = newDir();
    const yamlPath = join(dir, "workers.yaml");
    process.env.PAI_WORKERS_YAML = yamlPath;
    const data = effectiveWorkersYamlData(join(dir, "none.yaml"));
    data.tiers[1]!.escalation = { after: 2, to: "t0" };
    const text = buildWorkersYamlText(data);
    expect(text).toContain("escalation:");
    writeWorkersYamlText(yamlPath, text);
    expect(readWorkersYaml(yamlPath)!.data.tiers[1]!.escalation).toEqual({ after: 2, to: "t0" });
  });
});
