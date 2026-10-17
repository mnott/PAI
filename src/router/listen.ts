import type http from "node:http";

export function listenRetry(
  server: http.Server,
  port: number,
  host: string,
  opts: { waitMs: number; intervalMs?: number }
): Promise<void> {
  const { waitMs, intervalMs = 100 } = opts;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && Date.now() - start < waitMs) {
        setTimeout(() => {
          server.listen(port, host);
        }, intervalMs);
      } else {
        reject(err);
      }
    };

    const onListening = () => {
      resolve();
    };

    server.on("error", onError);
    server.on("listening", onListening);

    server.listen(port, host);

    // Clean up listeners when settled
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    // Override resolve and reject to ensure cleanup
    const originalResolve = resolve;
    const originalReject = reject;

    resolve = (value?: void | PromiseLike<void>) => {
      cleanup();
      originalResolve(value);
    };

    reject = (reason?: any) => {
      cleanup();
      originalReject(reason);
    };
  });
}