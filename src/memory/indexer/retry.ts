/**
 * Retry logic for transient database errors during embedding.
 *
 * Detects transient connection/pool/serialization errors and retries with
 * exponential backoff from 2s to 60s, up to 30 minutes total.
 * Non-transient errors (SQL, model, etc) fail fast.
 */

export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Check if an error is transient (retryable) or permanent.
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();
  const code = (error as unknown as Record<string, unknown>).code as string | undefined;

  // Connection errors
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND") return true;
  if (msg.includes("timeout") && msg.includes("connect")) return true;
  if (msg.includes("connection terminated")) return true;
  if (msg.includes("pool connect timeout")) return true;

  // Postgres-specific error codes: admin shutdown (57P01), serialization failure (40001), deadlock (40P01)
  if (msg.includes("57p01") || msg.includes("admin shutdown")) return true;
  if (msg.includes("40001") || msg.includes("serialization failure")) return true;
  if (msg.includes("40p01") || msg.includes("deadlock")) return true;

  return false;
}

export interface RetryOptions {
  /** Initial backoff in ms (default 2000). */
  initialDelayMs?: number;
  /** Max backoff in ms (default 60000). */
  maxDelayMs?: number;
  /** Max total time to retry in ms (default 30 minutes). */
  timeoutMs?: number;
  /** Logger function for retry attempts (default console.error with [pai-daemon] prefix). */
  logger?: (attempt: number, delayMs: number, error: Error) => void;
}

/**
 * Retry a function on transient errors with exponential backoff.
 * Non-transient errors throw immediately.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const initialDelay = options?.initialDelayMs ?? 2000;
  const maxDelay = options?.maxDelayMs ?? 60000;
  const timeout = options?.timeoutMs ?? 30 * 60 * 1000; // 30 minutes
  const logger = options?.logger ?? defaultLogger;

  const deadline = Date.now() + timeout;
  let attempt = 0;
  let delay = initialDelay;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Non-transient: fail fast
      if (!isTransientError(error)) {
        throw error;
      }

      attempt++;
      const now = Date.now();
      const remaining = deadline - now;

      // Retry budget exhausted
      if (remaining <= 0) {
        throw new Error(
          `Transient error: retry budget exhausted after ${attempt} attempts over ${timeout}ms: ${error.message}`
        );
      }

      // Cap delay to budget
      const actualDelay = Math.min(delay, remaining);
      logger(attempt, actualDelay, error);

      await new Promise((r) => setTimeout(r, actualDelay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

function defaultLogger(attempt: number, delayMs: number, error: Error): void {
  console.error(
    `[pai-daemon] Embed: transient error on attempt ${attempt}, retry in ${delayMs}ms: ${error.message}`
  );
}
