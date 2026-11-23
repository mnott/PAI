/**
 * Let the event loop run its pending I/O (IPC requests, timers) before the
 * caller continues. Long supervision passes call this between steps and
 * between items so no single slice holds the daemon for more than one item.
 */
export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
