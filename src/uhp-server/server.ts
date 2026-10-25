/**
 * server.ts — the HTTP surface of PAI as a UHP server (core class). Routing
 * only: every handler lives in the module named for its resource. Every
 * response carries `UHP-Version`; errors use the structured envelope.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { readWorkersSection, type WorkersConfig } from "../workers/config.js";
import { probeEndpointUrl } from "../workers/endpoint-health.js";
import { workersLogDir } from "../workers/paths.js";
import { authenticate } from "./auth.js";
import { discoveryBody } from "./discovery.js";
import { UHP_DEFAULT_VERSION, UHP_VERSIONS, UhpHttpError, errorBody, internalError, invalidInput, notFound } from "./errors.js";
import { harnessObject, listHarnesses } from "./harnesses.js";
import { harnessModels, modelCatalog, type EndpointProbe } from "./models.js";
import {
  cancelResponse, createResponse, deleteResponse, getRecord, inputItems, snapshot, streamResponse, waitTerminal, type ServerCtx,
} from "./responses.js";
import { inProcessRunner, type WorkerRunner } from "./runner.js";
import { UhpStore } from "./store.js";

export interface UhpServerOptions {
  /** Where tokens.json, responses/ and idempotency/ live; default <PAI_HOME>/uhp. */
  stateDir?: string;
  tokensPath?: string;
  config?: () => WorkersConfig;
  logDir?: string;
  runner?: WorkerRunner;
  probe?: EndpointProbe;
  keepAliveMs?: number;
  pollMs?: number;
  /** Product version reported in discovery. */
  version?: string;
}

export const defaultStateDir = (): string => paiHomePath("uhp");

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new UhpHttpError(413, "invalid_request_error", "invalid_input", "the request body is too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

export function createUhpServer(opts: UhpServerOptions = {}): Server {
  const config = opts.config ?? ((): WorkersConfig => readWorkersSection().workers);
  const logDir = opts.logDir ?? workersLogDir(config());
  const stateDir = opts.stateDir ?? defaultStateDir();
  const tokensPath = opts.tokensPath ?? join(stateDir, "tokens.json");
  const store = new UhpStore(stateDir);
  const ctx: ServerCtx = {
    config,
    logDir,
    store,
    runner: opts.runner ?? inProcessRunner(logDir),
    probe: opts.probe ?? ((u) => probeEndpointUrl(u)),
    keepAliveMs: opts.keepAliveMs ?? 15_000,
    pollMs: opts.pollMs ?? 100,
  };
  const productVersion = opts.version ?? "0";
  const createdAt = Date.now();

  async function route(req: IncomingMessage, res: ServerResponse, version: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const seg = path.split("/").filter(Boolean);
    if (seg[0] !== "v1") throw notFound("not_found", "no such endpoint");

    if (method === "GET" && path === "/v1/uhp") return send(res, 200, discoveryBody(productVersion));

    const principal = authenticate(tokensPath, req.headers.authorization);

    // harnesses and models
    if (method === "GET" && path === "/v1/harnesses") {
      const cfg = ctx.config();
      return send(res, 200, { object: "list", harnesses: listHarnesses(cfg).map((h) => harnessObject(h, cfg, createdAt)) });
    }
    if (seg[1] === "harnesses" && seg.length >= 3 && method === "GET") {
      const cfg = ctx.config();
      const h = listHarnesses(cfg).find((x) => x.id === seg[2]);
      if (!h) throw notFound("harness_not_found", "no such harness");
      if (seg.length === 3) return send(res, 200, harnessObject(h, cfg, createdAt));
      if (seg.length === 4 && seg[3] === "models") return send(res, 200, await harnessModels(h, cfg.providers[h.provider]!, ctx.probe));
    }
    if (method === "GET" && path === "/v1/models") {
      const cfg = ctx.config();
      return send(res, 200, await modelCatalog(cfg.providers, listHarnesses(cfg), ctx.probe));
    }

    // responses
    if (path === "/v1/responses" && method === "POST") {
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw invalidInput("the request body is not valid JSON");
      }
      const key = req.headers["idempotency-key"];
      const { rec, req: parsed } = await createResponse(ctx, principal, body, typeof key === "string" && key ? key : undefined);
      if (parsed.stream) return streamResponse(ctx, rec, res);
      if (parsed.background) return send(res, 200, snapshot(ctx, rec));
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      return send(res, 200, await waitTerminal(ctx, rec, () => closed));
    }
    if (seg[1] === "responses" && seg.length >= 3) {
      const rec = getRecord(ctx, principal, seg[2]!);
      if (seg.length === 3 && method === "GET") return send(res, 200, snapshot(ctx, rec));
      if (seg.length === 3 && method === "DELETE") return send(res, 200, deleteResponse(ctx, rec));
      if (seg.length === 4 && seg[3] === "input_items" && method === "GET") return send(res, 200, inputItems(rec));
      if (seg.length === 4 && seg[3] === "cancel" && method === "POST") return send(res, 200, cancelResponse(ctx, principal, rec));
    }
    if (seg[1] === "sessions" && seg.length === 4 && seg[3] === "cancel" && method === "POST") {
      const sid = seg[2]!;
      const recs = store.bySession(sid, principal);
      if (!recs.length) throw notFound("session_not_found", "no such session");
      const last = recs[recs.length - 1]!;
      return send(res, 200, cancelResponse(ctx, principal, last));
    }
    throw notFound("not_found", "no such endpoint");
  }

  return createServer((req, res) => {
    // a version the server does not speak is refused, never silently substituted
    const asked = req.headers["uhp-version"];
    const version = typeof asked === "string" && asked ? asked : UHP_DEFAULT_VERSION;
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = ((...a: Parameters<ServerResponse["writeHead"]>) => {
      res.setHeader("UHP-Version", (UHP_VERSIONS as readonly string[]).includes(version) ? version : UHP_DEFAULT_VERSION);
      return origWriteHead(...a);
    }) as ServerResponse["writeHead"];
    const fail = (e: unknown): void => {
      let err: UhpHttpError;
      if (e instanceof UhpHttpError) err = e;
      else {
        const cid = randomBytes(6).toString("hex");
        console.error(`uhp-server: ${cid}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        err = internalError(cid);
      }
      if (res.headersSent) return void res.end();
      send(res, err.status, errorBody(err), err.headers);
    };
    if (!(UHP_VERSIONS as readonly string[]).includes(version)) {
      return fail(new UhpHttpError(400, "invalid_request_error", "unsupported_protocol_version", "this server does not speak that UHP version", "UHP-Version", { supported: [...UHP_VERSIONS] }));
    }
    route(req, res, version).catch(fail);
  });
}
