import http from "node:http";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

/** The responses a router has started and not yet finished: counted at handover, ended cleanly when the drain limit is reached. */
export interface Inflight {
  wrap: (h: Handler) => Handler;
  count: () => number;
  /** Ends every unfinished response: an SSE error event on a stream already started, else 503 + Retry-After. Returns how many. */
  endAll: (message: string) => number;
}

export function trackInflight(): Inflight {
  const open = new Set<http.ServerResponse>();
  return {
    wrap: (h) => (req, res) => {
      open.add(res);
      res.once("close", () => open.delete(res));
      return h(req, res);
    },
    count: () => open.size,
    endAll: (message) => {
      let n = 0;
      for (const res of open) {
        if (res.writableEnded || res.destroyed) continue;
        n++;
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
      }
      return n;
    },
  };
}
