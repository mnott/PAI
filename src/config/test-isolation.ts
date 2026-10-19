/**
 * test-isolation.ts — the mechanism behind "tests never touch the live PAI
 * config and never send real notifications".
 *
 * Observed 2026-10-19: a vitest run rewrote the operator's live config.yaml
 * and pushed real notifications to their phone. A convention ("give your
 * test a temp home") did not hold, so the writers refuse instead.
 *
 * The real home comes from os.userInfo().homedir (the passwd entry), NOT
 * $HOME / os.homedir(): tests redirect those, and a test that leaks past the
 * redirect is exactly what this guard catches.
 */

import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

/** True under vitest, NODE_ENV=test or bun test. */
export function isTestRunner(): boolean {
  const e = process.env;
  return !!e.VITEST || e.NODE_ENV === "test" || !!e.BUN_TEST;
}

function realHome(): string | null {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
}

/** Throw if a test runner is about to write a live PAI file (PAI home tree or ~/.claude.json). */
export function assertTestWriteAllowed(path: string): void {
  if (!isTestRunner()) return;
  const home = realHome();
  if (!home) return;
  const target = resolve(path);
  const paiHomes = [join(home, ".claude", "pai"), join(home, ".pai")];
  const claudeJson = join(home, ".claude.json");
  if (target === claudeJson || target.startsWith(claudeJson + ".") || paiHomes.some((h) => target === h || target.startsWith(h + sep))) {
    throw new Error(
      `refusing to write ${path}: test-isolation rule — tests must never write the live PAI config; ` +
        `use a temp PAI home (PAI_HOME=<mkdtemp dir>) instead`
    );
  }
}
