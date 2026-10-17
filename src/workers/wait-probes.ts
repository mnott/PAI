/**
 * wait-probes.ts — bounded waits for a server to answer and for files to appear:
 * `pai worker wait-url <url>` and `pai worker wait-file <path...>`. Siblings of
 * wait-on (a pid) and wait (child workers); each returns within --max seconds
 * (default 100, limit 115) so the caller loops a few times instead of sleeping.
 *
 * Exit codes: 0 ready, 3 not yet at --max, 2 unusable arguments.
 */

import { existsSync } from "node:fs";

export const PROBE_DEFAULT_SECS = 100;
export const PROBE_CAP_SECS = 115;

export interface ProbeDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  /** HTTP status of a GET, or an error word ("connection refused", "timeout") when nothing answered. */
  get: (url: string, timeoutMs: number) => Promise<number | string>;
  exists: (path: string) => boolean;
}

export const realProbeDeps: ProbeDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  out: (l) => console.log(l),
  async get(url, timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      void res.body?.cancel();
      return res.status;
    } catch (e) {
      const err = e as { name?: string; cause?: { code?: string } };
      if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
      return err.cause?.code === "ECONNREFUSED" ? "connection refused" : (err.cause?.code ?? "no answer");
    }
  },
  exists: existsSync,
};

const maxMsOf = (secs: number | undefined): number => Math.min(secs ?? PROBE_DEFAULT_SECS, PROBE_CAP_SECS) * 1000;
const secsSince = (d: ProbeDeps, t0: number): number => Math.round((d.now() - t0) / 1000);

/** Up once the server answers with any 2xx-4xx status (a 404 or 401 still proves the port serves HTTP). */
export async function waitUrl(o: { url: string; maxSecs?: number }, d: ProbeDeps = realProbeDeps): Promise<number> {
  try {
    new URL(o.url);
  } catch {
    d.out(`wait-url: invalid url ${o.url}`);
    return 2;
  }
  const maxMs = maxMsOf(o.maxSecs);
  const t0 = d.now();
  let delay = 500;
  let last: number | string = "no answer";
  for (;;) {
    last = await d.get(o.url, 3000);
    if (typeof last === "number" && last >= 200 && last < 500) {
      d.out(`up: ${o.url} answered HTTP ${last} after ${secsSince(d, t0)}s`);
      return 0;
    }
    const left = maxMs - (d.now() - t0);
    if (left <= 0) break;
    await d.sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, 5000);
  }
  d.out(`not yet: ${o.url} (last: ${typeof last === "number" ? `HTTP ${last}` : last}) after ${secsSince(d, t0)}s; call wait-url again`);
  return 3;
}

/** Ready once every path exists; one status line per path. */
export async function waitFile(o: { paths: string[]; maxSecs?: number }, d: ProbeDeps = realProbeDeps): Promise<number> {
  if (o.paths.length === 0) {
    d.out("wait-file: no path given");
    return 2;
  }
  const maxMs = maxMsOf(o.maxSecs);
  const t0 = d.now();
  const missing = () => o.paths.filter((p) => !d.exists(p));
  while (missing().length > 0 && d.now() - t0 < maxMs) {
    await d.sleep(Math.min(1000, Math.max(1, maxMs - (d.now() - t0))));
  }
  const gone = new Set(missing());
  for (const p of o.paths) d.out(gone.has(p) ? `missing: ${p}` : `exists: ${p}`);
  if (gone.size > 0) {
    d.out(`not yet: ${gone.size} of ${o.paths.length} missing after ${secsSince(d, t0)}s; call wait-file again`);
    return 3;
  }
  return 0;
}
