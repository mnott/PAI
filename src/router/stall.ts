import type http from "node:http";

/** One handler call that kept the event loop busy: the request path and how long its synchronous part ran. */
interface SyncRun {
  path: string;
  at: number;
  ms: number;
}

export interface StallMonitor {
  /** wraps the request handler: tracks the URL while in flight and times its synchronous part */
  wrap(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): (req: http.IncomingMessage, res: http.ServerResponse) => void;
  stop(): void;
}

export interface StallOptions {
  /** a loop blocked longer than this is logged */
  thresholdMs: number;
  /** how often the loop is checked for drift */
  tickMs?: number;
  log: (line: string) => void;
  now?: () => number;
}

const RECENT = 20;
const SLOW_SYNC_MS = 50;

/**
 * Event-loop stall detector: a timer that should fire every tickMs; when it
 * fires thresholdMs late the loop was blocked. The line names the requests in
 * flight and the recent handler calls whose synchronous part was slow, which
 * is where a blocking call (spawnSync, readFileSync of a big log) shows up.
 */
export function startStallMonitor(o: StallOptions): StallMonitor {
  const now = o.now ?? Date.now;
  const tick = o.tickMs ?? 100;
  const inflight = new Map<http.IncomingMessage, string>();
  const recent: SyncRun[] = [];
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const stall = t - last - tick;
    const from = last;
    last = t;
    if (stall <= o.thresholdMs) return;
    const paths = [...new Set(inflight.values())];
    const slow = recent.filter((r) => r.at + r.ms >= from && r.ms >= SLOW_SYNC_MS).map((r) => `${r.path} ${r.ms}ms`);
    o.log(
      `${new Date(t).toISOString()} event-loop stall ${stall} ms; in flight: ${paths.join(", ") || "-"}; slow sync handlers: ${slow.join(", ") || "-"}`
    );
  }, tick);
  timer.unref();
  return {
    wrap(handler) {
      return (req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        inflight.set(req, path);
        const done = () => inflight.delete(req);
        res.once("close", done);
        const at = now();
        try {
          handler(req, res);
        } catch (e) {
          o.log(`${new Date(now()).toISOString()} handler error on ${path}: ${(e as Error)?.stack ?? String(e)}`);
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, message: "internal error" }));
          } else res.end();
        } finally {
          const ms = now() - at;
          if (ms >= SLOW_SYNC_MS) {
            recent.push({ path, at, ms });
            if (recent.length > RECENT) recent.shift();
          }
        }
      };
    },
    stop: () => clearInterval(timer),
  };
}
