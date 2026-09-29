/**
 * service-manager.ts — the one guard in front of every launchctl / systemctl call.
 *
 * Unit and plist files land under $HOME, but launchctl and systemctl --user act
 * on the real account's session whatever HOME says. Run under a foreign HOME
 * (a temp dir, a test, a sandbox) they rewire the live service to that HOME's
 * files. So when HOME is not the account home the files are still written and
 * the service manager is left alone.
 */

import { homedir, userInfo } from "node:os";

/** True when it is safe to call launchctl/systemctl; otherwise prints why not and how to finish by hand. */
export function serviceManagerAllowed(manualCommand: string): boolean {
  if (homedir() === userInfo().homedir) return true;
  console.log(`  service not (re)loaded because HOME is not the account home; as the real user run: ${manualCommand}`);
  return false;
}
