import http from "node:http";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

/** The responses a router has started and not yet finished: counted at handover, ended cleanly only when idle too long (or at the ceiling). */
export interface Inflight {
  wrap: (h: Handler) => Handler;
  count: () => number;
  /** Requests not made by a worker run (no x-pai-worker header): a turn of an interactive session. */
  interactive: () => number;
  /** Ends every unfinished response: an SSE error event on a stream already started, else 503 + Retry-After. Returns how many. */
  endAll: (message: string) => number;
  /** Ends only the responses that wrote no byte (and received none) for `idleMs`. Returns how many. */
  endIdle: (idleMs: number, message: string) => number;
}

interface Entry { worker: boolean; last: number }

export function trackInflight(now: () => number = Date.now): Inflight {
  const open = new Map<http.ServerResponse, Entry>();
  const end = (res: http.ServerResponse, message: string): boolean => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message } })}\n\n`);
      } else {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "1", connection: "close" });
        res.write(JSON.stringify({ type: "error", error: { type: "overloaded_error", message } }));
      }
      res.end();
    } catch {
      /* socket already gone */
    }
    return true;
  };
  return {
    wrap: (h) => (req, res) => {
      const entry: Entry = { worker: !!req.headers["x-pai-worker"], last: now() };
      open.set(res, entry);
      res.once("close", () => open.delete(res));
      // every byte written to the client (or received from it) is activity
      const write = res.write.bind(res) as (...a: unknown[]) => boolean;
      res.write = ((...a: unknown[]) => { entry.last = now(); return write(...a); }) as typeof res.write;
      req.on("data", () => { entry.last = now(); });
      return h(req, res);
    },
    count: () => open.size,
    interactive: () => [...open.values()].filter((e) => !e.worker).length,
    endAll: (message) => {
      let n = 0;
      for (const res of open.keys()) if (end(res, message)) n++;
      return n;
    },
    endIdle: (idleMs, message) => {
      let n = 0;
      const t = now();
      for (const [res, e] of open) if (t - e.last >= idleMs && end(res, message)) n++;
      return n;
    },
  };
}
