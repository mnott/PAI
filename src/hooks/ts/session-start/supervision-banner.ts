#!/usr/bin/env node

/**
 * supervision-banner.ts — SessionStart hook (matchers: startup, compact)
 *
 * Injects "SUPERVISION ACTIVE ..." when an AIBroker watcher for this session
 * is live. See ../lib/supervision-banner.ts. Never blocks: always exits 0.
 */

import { supervisionBannerForSession } from "../lib/supervision-banner.js";
import { isWorkerSession } from "../lib/worker-session.js";

async function main() {
  if (isWorkerSession()) return;
  const banner = await supervisionBannerForSession(process.env);
  if (banner) console.log(banner);
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
