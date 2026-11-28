import os from 'node:os';

/** Read all of stdin; rejects with `Error(timeoutMessage)` when it does not end within `timeout` ms. */
export function readStdinWithTimeout(timeout: number, timeoutMessage = 'Timeout'): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeout);

    process.stdin.on('data', (chunk) => {
      data += chunk.toString();
    });

    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });

    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Parse the hook's JSON stdin, waiting at most 500 ms; null when empty, late or malformed. */
export async function readHookInput<T>(): Promise<T | null> {
  try {
    const decoder = new TextDecoder();
    let input = '';
    const timeoutPromise = new Promise<void>((resolve) => { setTimeout(resolve, 500); });
    const readPromise = (async () => {
      for await (const chunk of process.stdin) {
        input += decoder.decode(chunk, { stream: true });
      }
    })();
    await Promise.race([readPromise, timeoutPromise]);
    if (input.trim()) return JSON.parse(input) as T;
  } catch {
    // Silently handle input errors
  }
  return null;
}

/**
 * Bound for waiting on a security hook's stdin EOF: 2 s plus 1 s per 1-minute
 * load unit above the core count, capped at 30 s (below the harness's own
 * 60 s default hook timeout). Only a truly hung pipe should reach it.
 */
export function stdinBoundMs(load: number, cores: number): number {
  const over = Math.max(0, load - cores);
  return Math.min(30_000, Math.round(2000 + over * 1000));
}

/**
 * Read a stream to EOF for a fail-closed hook. Rejects with `Error('timeout')`
 * only when EOF does not arrive within `boundMs` (default: load-scaled bound).
 */
export async function readStdinToEnd(
  stream: AsyncIterable<Buffer | string> = process.stdin,
  boundMs?: number,
): Promise<string> {
  const bound = boundMs ?? stdinBoundMs(os.loadavg()[0] ?? 0, os.cpus().length || 1);
  const chunks: Buffer[] = [];
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), bound);
  });
  const readPromise = (async () => {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  })();
  readPromise.catch(() => {});
  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
