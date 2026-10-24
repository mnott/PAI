export interface RestartDeps {
  oldPid: number | undefined;                 // running router, if any
  spawnNew: (oldPid: number | undefined) => number | undefined; // starts the new router, returns its pid; it warms up, then stops oldPid itself and takes the port (see routerSwapArgs)
  isUp: () => Promise<boolean>;               // true when GET /cockpit/system answers on the router port
  handover?: (oldPid: number) => Promise<number | undefined> | null; // gapless: old router passes its listening socket on; null = old router cannot, fall back to spawnNew
  /** Run in this process before anything is started: a failure here aborts the restart (message names host and code). */
  preflight?: () => Promise<{ ok: boolean; host: string; code?: string }>;
  /** After the new router answers: the abort message when the successor reported it cannot reach the upstream and left the old router serving. */
  aborted?: (oldPid: number, newPid: number | undefined) => string | undefined | Promise<string | undefined>;
  /** Spawn path only: true once the successor owns the router pid file or has exited; until then an answering port may still be the old router. */
  settled?: (newPid: number | undefined) => boolean;
  now?: () => number;                        // default Date.now
  pollMs?: number;                            // default 50
  timeoutMs?: number;                         // default 30000
  sleep?: (ms: number) => Promise<void>;      // default setTimeout based
}

export interface RestartResult {
  newPid: number | undefined;
  oldPid: number | undefined;
  gapMs: number | undefined;
  readyMs: number
}

/** The restart was abandoned on purpose and the old router keeps serving. */
export class RestartAborted extends Error {}

export async function restartRouter(d: RestartDeps): Promise<RestartResult> {
  const now = d.now || Date.now;
  const pollMs = d.pollMs || 50;
  const timeoutMs = d.timeoutMs || 30000;
  const sleep = d.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));

  if (d.preflight) {
    const p = await d.preflight();
    if (!p.ok) throw new RestartAborted(`router restart aborted: successor cannot reach ${p.host}: ${p.code ?? "unknown"}; old router ${d.oldPid ?? "none"} keeps serving`);
  }

  // Start the new router first; readyMs counts from here, spawn time included
  const startTime = now();
  const handed = d.oldPid !== undefined ? d.handover?.(d.oldPid) ?? null : null;
  const newPid = handed ? await handed : d.spawnNew(d.oldPid);

  let oldPid = d.oldPid;
  let signalTime: number | undefined = undefined;
  let firstFailureTime: number | undefined = undefined;
  let firstSuccessTime: number | undefined = undefined;
  let maxGapMs = 0;

  if (oldPid !== undefined) signalTime = startTime;

  // Poll until the new router is ready
  while (true) {
    const isUp = await d.isUp();

    if (isUp && !handed && d.oldPid !== undefined && d.settled && !d.settled(newPid)) {
      // still the old router answering; the successor is in its preflight
    } else if (isUp) {
      // the old router answers while a successor that failed its preflight has already exited
      const why = d.oldPid !== undefined ? await d.aborted?.(d.oldPid, newPid) : undefined;
      if (why) throw new RestartAborted(why);
      // First success after signal
      if (firstSuccessTime === undefined) {
        firstSuccessTime = now();
        // Calculate gapMs as the longest run of consecutive failed polls
        if (firstFailureTime !== undefined) {
          maxGapMs = firstSuccessTime - firstFailureTime;
        }
      }
      break;
    } else {
      // First failure after signal
      if (firstFailureTime === undefined && signalTime !== undefined) {
        firstFailureTime = now();
      }

      // Track the longest gap
      if (firstFailureTime !== undefined) {
        const currentGap = now() - firstFailureTime;
        if (currentGap > maxGapMs) {
          maxGapMs = currentGap;
        }
      }
    }

    // Check timeout
    if (now() - startTime > timeoutMs) {
      throw new Error(`new router did not answer within ${timeoutMs}ms`);
    }

    await sleep(pollMs);
  }

  // Calculate readyMs as time from before the spawn to first success
  const readyMs = firstSuccessTime !== undefined ? firstSuccessTime - startTime : 0;

  // gapMs is undefined when oldPid was undefined, 0 if no failures, otherwise the gap
  const gapMs = oldPid === undefined ? undefined :
                firstFailureTime === undefined ? 0 :
                maxGapMs;

  return {
    newPid,
    oldPid,
    gapMs,
    readyMs
  };
}