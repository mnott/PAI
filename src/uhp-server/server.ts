/** The UHP HTTP server: version check, routing, auth, error envelope. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readWorkersSection, type WorkersConfig } from "../workers/config.js";
import { authenticate, tokensFilePath } from "./auth.js";
import { discoveryDoc } from "./discovery.js";
import { UHP_DEFAULT_VERSION, UHP_VERSIONS, UhpError, sendError, sendJson, uhpError, unsupportedVersion } from "./errors.js";
import { findEntry, listHarnessEntries, visibleEntries } from "./harnesses.js";
import { harnessModels, modelCatalog, modelsOf, type Probe } from "./models.js";

export interface UhpServerOptions {
  tokensPath?: string;
  implVersion?: string;
  /** Workers config source; tests inject a fixture. */
  loadWorkers?: () => WorkersConfig;
  probe?: Probe;
  /** Capabilities the mounted routes provide (A1: none beyond discovery/harnesses/models). */
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

export function createUhpServer(opts: UhpServerOptions = {}): Server {
  const o = {
    tokensPath: tokensFilePath(opts.tokensPath),
    implVersion: opts.implVersion ?? "0.0.0",
    loadWorkers: opts.loadWorkers ?? (() => readWorkersSection().workers),
    probe: opts.probe,
    routes: opts.routes ?? new Set<string>(),
  };
  return createServer((req, res) => {
    handle(req, res, o).catch((e) => {
      if (e instanceof UhpError) return sendError(res, e);
      sendError(res, uhpError(500, null, "internal_error", "The server failed to handle the request"));
    });
  });
}
