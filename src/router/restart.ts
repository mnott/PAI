export interface RestartDeps {
  oldPid: number | undefined;                 // running router, if any
  spawnNew: () => number | undefined;         // starts the new router (it waits for the port itself), returns its pid
  signalOld: (pid: number) => void;           // SIGTERM to the old router
  isUp: () => Promise<boolean>;               // true when GET /cockpit/system answers on the router port
  now?: () => number;                         // default Date.now
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
  const newPid = d.spawnNew();

  let oldPid = d.oldPid;
  let signalTime: number | undefined = undefined;
  let firstFailureTime: number | undefined = undefined;
  let firstSuccessTime: number | undefined = undefined;
  let consecutiveFailures = 0;
  let maxGapMs = 0;

  // If there's an old router, signal it to shut down
  if (oldPid !== undefined) {
    signalTime = now();
    d.signalOld(oldPid);
  }

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