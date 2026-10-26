/** The UHP HTTP server: version check, routing, auth, error envelope. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readWorkersSection, type WorkersConfig } from "../workers/config.js";
import { authenticate, tokensFilePath } from "./auth.js";
import { discoveryDoc } from "./discovery.js";
import { UHP_DEFAULT_VERSION, UHP_VERSIONS, UhpError, sendError, sendJson, uhpError, unsupportedVersion } from "./errors.js";
import { findEntry, listHarnessEntries, visibleEntries } from "./harnesses.js";
import { harnessModels, modelCatalog, modelsOf, type Probe } from "./models.js";
import { cancelResponse, cancelSession, createResponse, getResponse, inputItems, removeResponse, type ResponsesDeps } from "./responses.js";
import type { RunsDeps } from "./runs.js";
import { sweepKeys } from "./store.js";
import { workersLogDir } from "../workers/paths.js";

export interface UhpServerOptions {
  tokensPath?: string;
  implVersion?: string;
  /** Workers config source; tests inject a fixture. */
  loadWorkers?: () => WorkersConfig;
  probe?: Probe;
  /** Where workers log and run (default: the workers config's logDir, the current directory). */
  runs?: RunsDeps;
  /** Capabilities the mounted routes provide (default: the response, event, session, cancel and idempotency routes). */
  routes?: ReadonlySet<string>;
}

async function handle(req: IncomingMessage, res: ServerResponse, o: Required<Omit<UhpServerOptions, "probe">> & { probe?: Probe }): Promise<void> {
  const requested = req.headers["uhp-version"];
  if (typeof requested === "string" && !(UHP_VERSIONS as readonly string[]).includes(requested)) throw unsupportedVersion(requested);
  const version = typeof requested === "string" ? requested : UHP_DEFAULT_VERSION;
  const path = new URL(req.url ?? "/", "http://uhp.local").pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (path === "/v1/uhp") {
    if (method !== "GET") throw uhpError(405, null, "method_not_allowed", "Use GET");
    return sendJson(res, 200, discoveryDoc(o.routes, o.implVersion), version);
  }

  const rm = /^\/v1\/(responses|sessions)(?:\/([^/]+)(?:\/(input_items|cancel))?)?$/.exec(path);
  if (rm) {
    const principal = authenticate(req, o.tokensPath);
    const workers = o.loadWorkers();
    const d: ResponsesDeps = { ...o.runs, workers, entries: listHarnessEntries(workers), probe: o.probe };
    const [, kind, id, sub] = rm;
    const id0 = id ? decodeURIComponent(id) : undefined;
    if (kind === "responses") {
      if (!id0) {
        if (method !== "POST") throw uhpError(405, null, "method_not_allowed", "Use POST");
        return createResponse(d, req, res, principal, version);
      }
      if (!sub && method === "GET") return getResponse(d, principal, id0, res, version);
      if (!sub && method === "DELETE") return removeResponse(principal, id0, res, version);
      if (sub === "input_items" && method === "GET") return inputItems(principal, id0, res, version);
      if (sub === "cancel" && method === "POST") return cancelResponse(d, principal, id0, res, version);
    } else if (id0 && sub === "cancel" && method === "POST") {
      return cancelSession(d, principal, id0, res, version);
    }
    throw uhpError(id0 ? 405 : 404, null, id0 ? "method_not_allowed" : "not_found", id0 ? "Method not allowed" : "No such endpoint");
  }

  const m = /^\/v1\/(harnesses|models)(?:\/([^/]+)(?:\/(models))?)?$/.exec(path);
  if (!m) {
    authenticate(req, o.tokensPath);
    throw uhpError(404, null, "not_found", "No such endpoint");
  }
  const principal = authenticate(req, o.tokensPath);
  if (method !== "GET") throw uhpError(405, null, "method_not_allowed", "Use GET");
  const entries = listHarnessEntries(o.loadWorkers());

  if (m[1] === "models") {
    if (m[2]) throw uhpError(404, null, "not_found", "No such endpoint");
    return sendJson(res, 200, await modelCatalog(visibleEntries(entries, principal), o.probe), version);
  }
  if (!m[2]) return sendJson(res, 200, { object: "list", harnesses: visibleEntries(entries, principal).map((e) => e.harness) }, version);
  const entry = findEntry(entries, principal, decodeURIComponent(m[2]));
  if (!m[3]) return sendJson(res, 200, entry.harness, version);
  return sendJson(res, 200, harnessModels(entry, await modelsOf(entry, o.probe)), version);
}

/** Capabilities of the mounted routes: streaming (SSE), sessions (previous_response_id), cancellation, idempotency (Idempotency-Key). */
export const DEFAULT_ROUTES = ["streaming", "sessions", "cancellation", "idempotency"] as const;

export function createUhpServer(opts: UhpServerOptions = {}): Server {
  sweepKeys();
  const o = {
    tokensPath: tokensFilePath(opts.tokensPath),
    implVersion: opts.implVersion ?? "0.0.0",
    loadWorkers: opts.loadWorkers ?? (() => readWorkersSection().workers),
    probe: opts.probe,
    routes: opts.routes ?? new Set<string>(DEFAULT_ROUTES),
    runs: opts.runs ?? { logDir: workersLogDir(readWorkersSection().workers), cwd: process.cwd() },
  };
  return createServer((req, res) => {
    handle(req, res, o).catch((e) => {
      if (e instanceof UhpError) return sendError(res, e);
      sendError(res, uhpError(500, null, "internal_error", "The server failed to handle the request"));
    });
  });
}
