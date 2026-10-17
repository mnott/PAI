/**
 * Run an old-style command and return its exit code. The old commands report
 * failure by setting process.exitCode; the new entry point exits with the
 * number a command returns, so the two are bridged here.
 */
export async function legacy(fn: () => Promise<void> | void): Promise<number> {
  process.exitCode = undefined;
  await fn();
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}
