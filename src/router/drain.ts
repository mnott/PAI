import http from 'http';

/** Close the servers, force-closing what is still open after `timeoutMs` (router.drainMs in config.yaml). */
export function drainServers(servers: http.Server[], opts: { timeoutMs: number; idleGraceMs?: number }): Promise<void> {
  const { timeoutMs, idleGraceMs = 0 } = opts;
  const startedAt = Date.now();

  // Track servers that are already closed or not listening
  const closedServers = new Set<http.Server>();

  // Track servers that are actively closing
  const closingServers = new Set<http.Server>();

  // Track the promises for each server's close operation
  const closePromises: Promise<void>[] = [];

  // Create a timer to track timeout
  let timeoutId: NodeJS.Timeout | null = null;

  // Create a timer to periodically call closeIdleConnections
  let idleCloseTimer: NodeJS.Timeout | null = null;

  // Function to handle server close completion
  const handleServerClose = (server: http.Server) => {
    closedServers.add(server);
    closingServers.delete(server);

    // If all servers are done, resolve the promise
    if (closedServers.size === servers.length) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (idleCloseTimer) {
        clearInterval(idleCloseTimer);
      }
    }
  };

  // Close each server
  for (const server of servers) {
    if (server.listening) {
      closingServers.add(server);

      // Create a promise for this server's close operation
      const closePromise = new Promise<void>((resolve) => {
        server.close((err) => {
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

  // Set up periodic idle connection cleanup
  idleCloseTimer = setInterval(() => {
    for (const server of servers) {
      if (closingServers.has(server) && Date.now() - startedAt >= idleGraceMs) {
        server.closeIdleConnections();
      }
    }
  }, 200);

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

      if (idleCloseTimer) {
        clearInterval(idleCloseTimer);
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
    if (idleCloseTimer) {
      clearInterval(idleCloseTimer);
    }
  });
}