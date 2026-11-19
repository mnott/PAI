/**
 * single-flight.ts — one computation per key per window, shared by every caller.
 *
 * A poll that several endpoints and clients hit at once (the cockpit queue) must not run its costly
 * read N times back to back: the first call computes, every call in the window gets the same result,
 * and a failed computation is retried on the next call rather than served as a broken value. The
 * compute runs synchronously — two cockpit requests arriving in one event-loop turn share it — but
 * an async one shares too: while a compute is in flight every caller awaits that same promise, so
 * N concurrent requests cost one computation.
 */

export interface SharedResult<T> {
  /** When the value was computed (ms). */
  at: number;
  value: T;
}

/**
 * A memoized single-flight around `compute`: within `ttlMs` of the last success every call returns
 * the same value; past it, this call computes once and everyone waiting gets that result. The key
 * (from `key(arg)`, e.g. a config stamp plus a directory) restarts the window when it changes, so a
 * saved config or a redirected log dir takes effect at once.
 */
export function singleFlight<T, A = void>(
  compute: (arg: A) => T | Promise<T>,
  opts: { ttlMs?: () => number; key?: (arg: A) => string } = {}
): (arg: A) => Promise<SharedResult<T>> {
  let last: { at: number; value: T; key: string | null } | null = null;
  let inflight: { promise: Promise<SharedResult<T>>; key: string | null } | null = null;
  return async (arg: A) => {
    const key = opts.key?.(arg) ?? null;
    const ttl = opts.ttlMs?.() ?? 0;
    if (last && last.key === key && Date.now() - last.at < ttl) return { at: last.at, value: last.value };
    if (inflight && inflight.key === key) return inflight.promise;
    const started = (async () => {
      const value = await compute(arg); // rejects: nothing is stored, the next call tries again
      last = { at: Date.now(), value, key };
      return { at: last.at, value };
    })();
    inflight = { promise: started, key };
    try {
      return await started;
    } finally {
      if (inflight?.promise === started) inflight = null;
    }
  };
}
