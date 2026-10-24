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
