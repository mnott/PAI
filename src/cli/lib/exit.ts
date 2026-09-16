/**
 * Safe process termination for the CLI.
 *
 * Node's stdout/stderr are ASYNCHRONOUS when they point at a pipe (and
 * synchronous when they point at a TTY or a regular file). `process.exit()`
 * tears the process down immediately, before any still-in-flight async
 * write completes — so a command whose output is piped (`pai ... | less`,
 * `| wc -c`, a subshell capture, etc.) can have its output silently
 * truncated or dropped entirely, while the same command run against a TTY
 * or redirected to a file prints correctly. Exit code is still 0, so the
 * failure is invisible.
 *
 * The robust fix, used everywhere it is possible, is to never call
 * `process.exit()` at all: set `process.exitCode` and let the command
 * return normally. Once the event loop has nothing left to do, Node exits
 * on its own — and a natural exit always flushes pending writes first.
 *
 * `exitAfterFlush` exists for the rare call site where control flow
 * genuinely cannot return (e.g. deep inside a callback with no path back
 * to the caller). It waits for both stdout and stderr to drain before
 * calling `process.exit()`.
 */

function streamDrained(stream: NodeJS.WriteStream): Promise<void> {
  // `writableLength` is the number of bytes still buffered and not yet
  // handed to the OS. If it's already 0, there is nothing to wait for.
  if (!stream.writableLength) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("drain", () => resolve());
    // Belt-and-braces: also resolve on the next tick after a short poll,
    // in case `drain` was already emitted before we attached the listener
    // (rare, but writableLength can hit 0 without a fresh `drain` event on
    // some platforms/versions).
    const check = () => {
      if (!stream.writableLength) resolve();
    };
    setImmediate(check);
  });
}

/**
 * Wait for stdout and stderr to finish flushing, then exit with `code`.
 * Never returns (the return type documents that; callers should not
 * expect code after this call to run).
 */
export async function exitAfterFlush(code: number): Promise<never> {
  await drainStdio();
  process.exit(code);
}

/**
 * Wait for stdout and stderr to finish flushing, without exiting.
 *
 * Belt-and-suspenders backstop for cli/index.ts: every command path avoids
 * process.exit() so a natural process exit — which always flushes pending
 * writes — can do the flushing. This makes that explicit and awaited at the
 * one place every command path funnels through, instead of trusting that
 * nothing between here and process shutdown (a dependency's keep-alive
 * socket being unref'd, a timer, anything else that can make the event loop
 * look "empty") lets Node begin tearing down before a write that's still
 * asynchronously in flight to a pipe has actually reached the OS.
 */
export async function drainStdio(): Promise<void> {
  await Promise.all([streamDrained(process.stdout), streamDrained(process.stderr)]);
}
