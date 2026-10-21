import http from 'http';
import net from 'net';

/** Close the servers, force-closing what is still open after `timeoutMs` (router.drainMs in config.yaml). */
export function drainServers(servers: http.Server[], opts: { timeoutMs: number; idleGraceMs?: number }): Promise<void> {
  const { timeoutMs, idleGraceMs = 0 } = opts;

  // Track servers that are already closed or not listening
  const closedServers = new Set<http.Server>();

  // Track servers that are actively closing
  const closingServers = new Set<http.Server>();

  // Track the promises for each server's close operation
  const closePromises: Promise<void>[] = [];

  // Create a timer to track timeout
  let timeoutId: NodeJS.Timeout | null = null;

  // Function to handle server close completion
  const handleServerClose = (server: http.Server) => {
    closedServers.add(server);
    closingServers.delete(server);

    // If all servers are done, resolve the promise
    if (closedServers.size === servers.length) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  // Close each server
  for (const server of servers) {
    if (server.listening) {
      closingServers.add(server);

      // Create a promise for this server's close operation
      const closePromise = new Promise<void>((resolve) => {
        // net's close: http.Server.close would reset every idle keep-alive socket at once, before its client's next request can be answered with Connection: close
        net.Server.prototype.close.call(server, (err?: Error) => {
          // If server was already closed, err will be ERR_SERVER_NOT_RUNNING
          if (err && (err as any).code === 'ERR_SERVER_NOT_RUNNING') {
            handleServerClose(server);
            resolve();
          } else {
            server.closeIdleConnections();
            handleServerClose(server);
            resolve();
          }
        });
      });

      closePromises.push(closePromise);
    } else {
      // Server not listening, treat as already closed
      closedServers.add(server);
    }
  }

  // If no servers to close, resolve immediately
  if (closePromises.length === 0) {
    return Promise.resolve();
  }

  // Idle keep-alive sockets end through the server's own per-socket timer, counted from each socket's last response.
  // A sweep closing every idle socket at once would reset those whose client is about to send its next request.
  if (idleGraceMs > 0) {
    for (const server of servers) {
      if (closingServers.has(server)) server.keepAliveTimeout = idleGraceMs;
    }
  }

  // Create the main promise that resolves when all servers are closed
  const mainPromise = Promise.all(closePromises);

  // Set up timeout
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      // Force close all remaining servers
      for (const server of servers) {
        if (closingServers.has(server)) {
          server.closeAllConnections();
        }
      }


      resolve();
    }, timeoutMs);
  });

  // Race between main promise and timeout
  return Promise.race([mainPromise, timeoutPromise]).then(() => {
    // Cleanup
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}