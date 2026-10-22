/**
 * Provision the F16 GGUF of arctic-embed-m-v1.5 into a local Ollama.
 * `ollama pull hf.co/...` fails on a Xet redirect, so the file is fetched
 * directly and imported with `ollama create`. No sudo; idempotent.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { paiHomePath } from "../../config/pai-home.js";
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

/** The Modelfile body; the path is quoted so a PAI_HOME with a space survives. */
export function modelfileText(gguf: string): string {
  return `FROM "${gguf.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
}

export interface GgufSource {
  url: string;
  size: number;
  sha256: string;
  fetchFn: (url: string, init: { redirect: "follow" }) => Promise<{ ok: boolean; status: number; body: unknown }>;
  log: (m: string) => void;
}

/**
 * Make `gguf` a verified copy of the model file. A present file is kept only
 * if size and checksum match (else it is deleted and fetched again); the
 * download goes to `<gguf>.part`, is verified, then renamed, so the final path
 * never holds a partial or corrupt file.
 */
export async function ensureGguf(gguf: string, o: Partial<GgufSource> = {}): Promise<void> {
  const src: GgufSource = { url: GGUF_URL, size: GGUF_SIZE, sha256: GGUF_SHA256, fetchFn: fetch as GgufSource["fetchFn"], log: (m) => console.log(m), ...o };
  if (existsSync(gguf)) {
    if (statSync(gguf).size === src.size && (await sha256File(gguf)) === src.sha256) return;
    src.log(`Existing ${gguf} is incomplete or corrupt; downloading again.`);
    rmSync(gguf, { force: true });
  }
  src.log(`Downloading ${src.url} (${Math.round(src.size / 1e6)} MB)...`);
  const res = await src.fetchFn(src.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const part = `${gguf}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    const size = statSync(part).size;
    if (size !== src.size) throw new Error(`Downloaded ${size} bytes, expected ${src.size}; the partial file was deleted, rerun to retry`);
    const sha = await sha256File(part);
    if (sha !== src.sha256) throw new Error(`Checksum mismatch for ${gguf}: got ${sha}; the corrupt download was deleted, rerun to retry`);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  renameSync(part, gguf);
}

export async function provisionOllama(opts: {
  baseUrl: string;
  model: string;
  /** Scratch dir for the download; default PAI_HOME/cache/ollama. */
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

  const dir = opts.workDir ?? paiHomePath("cache", "ollama");
  mkdirSync(dir, { recursive: true });
  const gguf = join(dir, "snowflake-arctic-embed-m-v1.5-F16.gguf");

  await ensureGguf(gguf, { log });

  const modelfile = join(dir, "Modelfile");
  writeFileSync(modelfile, modelfileText(gguf));
  log(`Importing as ${opts.model} (ollama create)...`);
  execFileSync(bin, ["create", opts.model, "-f", modelfile], { stdio: "inherit", env: { ...process.env, OLLAMA_HOST: opts.baseUrl } });
  return { created: true };
}
