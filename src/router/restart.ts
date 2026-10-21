export interface RestartDeps {
  oldPid: number | undefined;                 // running router, if any
  spawnNew: (oldPid: number | undefined) => number | undefined; // starts the new router, returns its pid; it warms up, then stops oldPid itself and takes the port (see routerSwapArgs)
  isUp: () => Promise<boolean>;               // true when GET /cockpit/system answers on the router port
  handover?: (oldPid: number) => Promise<number | undefined> | null; // gapless: old router passes its listening socket on; null = old router cannot, fall back to spawnNew
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

export async function restartRouter(d: RestartDeps): Promise<RestartResult> {
  const now = d.now || Date.now;
  const pollMs = d.pollMs || 50;
  const timeoutMs = d.timeoutMs || 30000;
  const sleep = d.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));

  // Start the new router first
  const handed = d.oldPid !== undefined ? d.handover?.(d.oldPid) ?? null : null;
  const newPid = handed ? await handed : d.spawnNew(d.oldPid);

  let oldPid = d.oldPid;
  let signalTime: number | undefined = undefined;
  let firstFailureTime: number | undefined = undefined;
  let firstSuccessTime: number | undefined = undefined;
  let consecutiveFailures = 0;
  let maxGapMs = 0;

  if (oldPid !== undefined) signalTime = now();

  const startTime = now();

  // Poll until the new router is ready
  while (true) {
    const isUp = await d.isUp();

    if (isUp) {
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

      // Track consecutive failures to calculate gap
      if (firstFailureTime !== undefined) {
        consecutiveFailures++;
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

  // Calculate readyMs as time from signal (or spawn when no old) to first success
  const readyMs = firstSuccessTime !== undefined ? firstSuccessTime - (signalTime || startTime) : 0;

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