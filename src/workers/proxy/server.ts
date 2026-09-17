/**
 * server.ts — the PAI worker proxy: Anthropic Messages API on the front,
 * OpenAI Chat Completions on the back, loopback only.
 *
 * One proxy serves every OpenAI-protocol provider: Claude Code points
 * ANTHROPIC_BASE_URL at `http://127.0.0.1:8797/<provider>` and the provider
 * name in the path selects the upstream (`upstreamUrl` + `keyFile` from the
 * workers config, re-read per request so config edits apply without a
 * restart). `run` starts the proxy on demand (detached, pid file under the
 * logDir) and `pai worker proxy stop` stops it again.
 *
 * All translation lives in translate.ts; this file is only HTTP plumbing.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkersSection, providerKeyPath, type WorkerProvider } from "../config.js";
import { workersLogDir } from "../paths.js";
import {
  anthropicError,
  anthropicToOpenAi,
  openAiToAnthropic,
  OpenAiStreamTranslator,
  type AnthropicRequest,
} from "./translate.js";

export const DEFAULT_PROXY_PORT = 8797;
const HOST = "127.0.0.1";

/** How providers are looked up — swapped out by the tests. */
export type ProviderResolver = () => Record<string, WorkerProvider>;

const configProviders: ProviderResolver = () => readWorkersSection().workers.providers;

export function proxyPidPath(logDir: string): string {
  return join(logDir, "proxy.pid");
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

interface ProxyServerOptions {
  port?: number;
  resolveProvider?: ProviderResolver;
  /** Test hook: called with every (translated) upstream request body. */
  onUpstreamRequest?: (url: string, body: unknown) => void;
}

/**
 * Create (but not start) the proxy server. Routes:
 *   GET  /healthz              → 200 ok
 *   POST /<provider>/v1/messages (and /<provider>/messages) → translated call
 */
export function createProxyServer(opts: ProxyServerOptions = {}): Server {
  const resolveProvider = opts.resolveProvider ?? configProviders;
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const m = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/(v1\/)?messages$/);
    if (req.method !== "POST" || !m) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify(anthropicError(404, `no such route: ${req.method} ${url.pathname}`)));
      return;
    }
    const providerName = m[1];
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void handleMessages(providerName, Buffer.concat(chunks).toString("utf8"), resolveProvider, res, opts);
    });
    req.on("error", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(anthropicError(400, "request body read failed")));
    });
  });
}

async function handleMessages(
  providerName: string,
  bodyText: string,
  resolveProvider: ProviderResolver,
  res: import("node:http").ServerResponse,
  opts: ProxyServerOptions
): Promise<void> {
  const fail = (status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(anthropicError(status, JSON.stringify({ message }))));
  };
  let reqBody: AnthropicRequest;
  try {
    reqBody = JSON.parse(bodyText) as AnthropicRequest;
  } catch {
    fail(400, "request body is not valid JSON");
    return;
  }
  const provider = resolveProvider()[providerName];
  if (!provider) {
    fail(404, `no worker provider named "${providerName}"`);
    return;
  }
  if (provider.protocol !== "openai" || !provider.upstreamUrl) {
    fail(400, `provider "${providerName}" is not an openai-protocol provider`);
    return;
  }

  const model = provider.models.default;
  const openaiBody = anthropicToOpenAi(reqBody, model);
  opts.onUpstreamRequest?.(`${provider.upstreamUrl}/chat/completions`, openaiBody);

  let upstream: Response;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const keyPath = providerKeyPath(provider);
    if (keyPath) {
      try {
        headers.authorization = `Bearer ${readFileSync(keyPath, "utf8").trim()}`;
      } catch {
        fail(500, `key file not readable: ${keyPath}`);
        return;
      }
    }
    upstream = await fetch(`${provider.upstreamUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(openaiBody),
    });
  } catch (e) {
    fail(502, `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(JSON.stringify(anthropicError(upstream.status, text)));
    return;
  }

  if (reqBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const translator = new OpenAiStreamTranslator(model);
    let buf = "";
    if (!upstream.body) {
      res.end(translator.finish());
      return;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            res.write(translator.finish());
          } else {
            try {
              res.write(translator.feed(JSON.parse(payload) as Parameters<typeof translator.feed>[0]));
            } catch {
              // skip a malformed chunk rather than kill the stream
            }
          }
        }
      }
    } finally {
      res.write(translator.finish()); // no-op when [DONE] already finished it
      res.end();
    }
    return;
  }

  const json = (await upstream.json().catch(() => null)) as unknown;
  if (!json) {
    fail(502, "upstream returned a non-JSON body");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(openAiToAnthropic(json as Parameters<typeof openAiToAnthropic>[0], model)));
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

/** Listen on host:port (loopback). Resolves with the bound port. */
export function listenProxy(server: Server, port = DEFAULT_PROXY_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

/** True when something already accepts connections on the port. */
export function proxyListening(port = DEFAULT_PROXY_PORT, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: HOST });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Where the standalone proxy artefact lives, found from this module's own
 * location (dist/cli bundle → ../hooks/, dev checkout → <repo>/dist/hooks).
 */
export function standaloneProxyPath(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    for (const cand of [
      join(dir, "worker-proxy.mjs"),
      join(dir, "hooks", "worker-proxy.mjs"),
      join(dir, "dist", "hooks", "worker-proxy.mjs"),
    ]) {
      if (existsSync(cand)) return cand;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Ensure a proxy is listening on the port; start the detached standalone when
 * nothing answers. Returns the base URL (`http://127.0.0.1:<port>`).
 */
export async function ensureProxyRunning(port: number, logDir: string): Promise<string> {
  if (await proxyListening(port)) return `http://${HOST}:${port}`;
  const script = standaloneProxyPath();
  if (!script) {
    throw new Error(
      `the PAI worker proxy is not running and its build was not found — ` +
        `run \`bun run build\` (or start one with: pai worker proxy --port ${port})`
    );
  }
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const child = spawn(process.execPath, [script, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(proxyPidPath(logDir), `${child.pid}\n`, "utf8");
  for (let i = 0; i < 40; i++) {
    if (await proxyListening(port)) return `http://${HOST}:${port}`;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the PAI worker proxy did not come up on port ${port} (see ${proxyPidPath(logDir)})`);
}

/** `pai worker proxy stop`: SIGTERM the pid from the pid file. */
export function stopProxy(logDir: string): string {
  const path = proxyPidPath(logDir);
  if (!existsSync(path)) return "no proxy pid file — nothing to stop";
  const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
  unlinkSync(path);
  if (!Number.isFinite(pid)) return "stale proxy pid file removed";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return `proxy pid ${pid} was not running (pid file removed)`;
  }
  return `proxy pid ${pid} stopped`;
}
