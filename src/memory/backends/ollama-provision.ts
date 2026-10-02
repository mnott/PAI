/**
 * Provision the F16 GGUF of arctic-embed-m-v1.5 into a local Ollama.
 * `ollama pull hf.co/...` fails on a Xet redirect, so the file is fetched
 * directly and imported with `ollama create`. No sudo; idempotent.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { probeOllama } from "./ollama.js";

export const GGUF_URL =
  "https://huggingface.co/yixuan-chia/snowflake-arctic-embed-m-v1.5-GGUF/resolve/main/snowflake-arctic-embed-m-v1.5-F16.gguf";
export const GGUF_SIZE = 219454752;
export const GGUF_SHA256 = "ece140d563b01d1e0cdbf836d5ac002c0a1e5bb254540177f4f4c4ae0793853a";

export function ollamaBinaryPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":").concat("/opt/homebrew/bin", "/usr/local/bin")) {
    if (dir && existsSync(join(dir, "ollama"))) return join(dir, "ollama");
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

export async function provisionOllama(opts: {
  baseUrl: string;
  model: string;
  /** Scratch dir for the download; default ~/.cache/pai/ollama. */
  workDir?: string;
  log?: (m: string) => void;
}): Promise<{ created: boolean }> {
  const log = opts.log ?? ((m) => console.log(m));
  const bin = ollamaBinaryPath();
  if (!bin) throw new Error("ollama is not installed (brew install ollama)");

  const probe = await probeOllama(opts.baseUrl, opts.model);
  if (probe.state === "ready") {
    log(`Model ${opts.model} already present; nothing to do.`);
    return { created: false };
  }
  if (probe.state === "server-down") throw new Error(`${probe.detail}; start it with \`ollama serve\``);

  const dir = opts.workDir ?? join(homedir(), ".cache", "pai", "ollama");
  mkdirSync(dir, { recursive: true });
  const gguf = join(dir, "snowflake-arctic-embed-m-v1.5-F16.gguf");

  if (!(existsSync(gguf) && statSync(gguf).size === GGUF_SIZE)) {
    log(`Downloading ${GGUF_URL} (${Math.round(GGUF_SIZE / 1e6)} MB)...`);
    const res = await fetch(GGUF_URL, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(gguf));
  }
  const size = statSync(gguf).size;
  if (size !== GGUF_SIZE) throw new Error(`Downloaded ${size} bytes, expected ${GGUF_SIZE}; delete ${gguf} and retry`);
  const sha = await sha256File(gguf);
  if (sha !== GGUF_SHA256) throw new Error(`Checksum mismatch for ${gguf}: ${sha}`);

  const modelfile = join(dir, "Modelfile");
  writeFileSync(modelfile, `FROM ${gguf}\n`);
  log(`Importing as ${opts.model} (ollama create)...`);
  execFileSync(bin, ["create", opts.model, "-f", modelfile], { stdio: "inherit", env: { ...process.env, OLLAMA_HOST: opts.baseUrl } });
  return { created: true };
}
