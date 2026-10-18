/**
 * Exit-code bridge for old-style commands. They report failure by setting
 * process.exitCode; the entry point exits with the number a command returns.
 */
export async function legacy(fn: () => Promise<void> | void): Promise<number> {
  process.exitCode = undefined;
  await fn();
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}
