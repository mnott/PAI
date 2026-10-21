/**
 * worker-chrome-rules.ts — a worker's direct Chrome/Chromium start must never reach the macOS keychain.
 *
 * Headless Chrome with a fresh profile asks the keychain for "Chrome Safe Storage" unless started with
 * --use-mock-keychain and --password-store=basic; the dialog lands on the operator's desktop. Workers
 * never drive the operator's real browser, so a non-headless start is denied outright.
 */

const CHROME_BIN = /(^|\/)(google chrome( for testing)?|chromium|chromium-browser|google-chrome(-stable)?|chrome)$/i;

export const HEADLESS_CHROME_FLAGS = "--use-mock-keychain --password-store=basic";

/** Deny reason for a direct Chrome binary invocation, null when the command is not one or is safe. */
export function chromeStartReason(cmd: string, args: string[]): string | null {
  if (!CHROME_BIN.test(cmd)) return null;
  if (args.some((a) => a === "--version" || a === "--help")) return null;
  const headless = args.some((a) => a === "--headless" || a.startsWith("--headless="));
  if (!headless) {
    return "non-headless Chrome blocked: workers never drive the operator's real browser; use --headless=new with " + HEADLESS_CHROME_FLAGS;
  }
  const missing = ["--use-mock-keychain", "--password-store=basic"].filter((f) => !args.includes(f));
  if (!missing.length) return null;
  return `headless Chrome without ${missing.join(" and ")} blocked: it asks the macOS keychain for "Chrome Safe Storage" and raises dialogs on the operator's desktop; add ${HEADLESS_CHROME_FLAGS}, and stop the process when done`;
}
