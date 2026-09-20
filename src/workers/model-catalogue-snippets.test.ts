/**
 * Validates the workers.yaml provider snippets published in
 * docs/model-catalogue.md actually parse. Each snippet is written to an
 * isolated temp workers.yaml (via PAI_WORKERS_YAML) and read back through
 * the real config loader — a syntax or schema mistake in the doc would
 * throw WorkersConfigError here instead of surfacing only when a user
 * pastes it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkersYaml, writeWorkersYamlText } from "./workers-config.js";

const dirs: string[] = [];
const savedYamlEnv = process.env.PAI_WORKERS_YAML;

function isolatedYamlPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pai-model-catalogue-"));
  dirs.push(dir);
  const yamlPath = join(dir, "workers.yaml");
  process.env.PAI_WORKERS_YAML = yamlPath;
  return yamlPath;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedYamlEnv === undefined) delete process.env.PAI_WORKERS_YAML;
  else process.env.PAI_WORKERS_YAML = savedYamlEnv;
});

const openaiProtocolSnippet = (name: string, upstreamUrl: string, defaultModel: string, fastModel?: string) => `
providers:
  ${name}:
    protocol: openai
    upstream_url: "${upstreamUrl}"
    key_file: "~/.claude/pai/keys/${name}"
    models:
      default: ${defaultModel}${fastModel ? `\n      fast: ${fastModel}` : ""}
    tier: 2
`;

const anthropicProtocolSnippet = (name: string, url: string, defaultModel: string) => `
providers:
  ${name}:
    url: "${url}"
    key_file: "~/.claude/pai/keys/${name}"
    models:
      default: ${defaultModel}
    tier: 2
`;

describe("docs/model-catalogue.md workers.yaml snippets parse", () => {
  it("openai snippet parses (protocol openai, upstream_url set)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      openaiProtocolSnippet("openai", "https://api.openai.com/v1", "gpt-5.1", "gpt-5-mini")
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.openai.protocol).toBe("openai");
    expect(data.providers.openai.upstreamUrl).toBe("https://api.openai.com/v1");
  });

  it("gemini snippet parses (protocol openai, upstream_url set)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      openaiProtocolSnippet(
        "gemini",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite"
      )
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.gemini.protocol).toBe("openai");
    expect(data.providers.gemini.upstreamUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
  });

  it("xai snippet parses (protocol openai, upstream_url set)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      openaiProtocolSnippet("xai", "https://api.x.ai/v1", "grok-4.6", "grok-build-0.1")
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.xai.protocol).toBe("openai");
    expect(data.providers.xai.upstreamUrl).toBe("https://api.x.ai/v1");
  });

  it("mistral snippet parses (protocol openai, upstream_url set)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      openaiProtocolSnippet(
        "mistral",
        "https://api.mistral.ai/v1",
        "mistral-large-latest",
        "mistral-small-latest"
      )
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.mistral.protocol).toBe("openai");
    expect(data.providers.mistral.upstreamUrl).toBe("https://api.mistral.ai/v1");
  });

  it("deepseek snippet parses (protocol openai, upstream_url set)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      openaiProtocolSnippet(
        "deepseek",
        "https://api.deepseek.com",
        "deepseek-v4-pro",
        "deepseek-flash"
      )
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.deepseek.protocol).toBe("openai");
    expect(data.providers.deepseek.upstreamUrl).toBe("https://api.deepseek.com");
  });

  it("glm2 snippet parses (protocol anthropic, no upstream_url)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      anthropicProtocolSnippet("glm2", "https://api.z.ai/api/anthropic", "glm-5.3")
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.glm2.protocol).toBe("anthropic");
    expect(data.providers.glm2.upstreamUrl).toBeUndefined();
  });

  it("kimi2 snippet parses (protocol anthropic, no upstream_url)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      anthropicProtocolSnippet("kimi2", "https://api.kimi.ai/coding/", "kimi-k3")
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.kimi2.protocol).toBe("anthropic");
    expect(data.providers.kimi2.upstreamUrl).toBeUndefined();
  });

  it("qwen snippet parses (protocol openai, upstream_url set)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      openaiProtocolSnippet(
        "qwen",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "qwen3.8-max",
        "qwen3.5-flash"
      )
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.qwen.protocol).toBe("openai");
    expect(data.providers.qwen.upstreamUrl).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    );
  });

  it("groq snippet parses (protocol openai, upstream_url set)", () => {
    const yamlPath = isolatedYamlPath();
    writeWorkersYamlText(
      yamlPath,
      openaiProtocolSnippet(
        "groq",
        "https://api.groq.com/openai/v1",
        "openai/gpt-oss-120b",
        "llama-3.1-8b-instant"
      )
    );
    const { data } = readWorkersYaml(yamlPath)!;
    expect(data.providers.groq.protocol).toBe("openai");
    expect(data.providers.groq.upstreamUrl).toBe("https://api.groq.com/openai/v1");
  });
});
