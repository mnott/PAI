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
