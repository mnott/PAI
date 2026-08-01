/**
 * `pai identity` — declare who "me" is.
 *
 * The list this edits is an allowlist for actions that reach the outside world
 * without review, outbound mail being the case it was built for. Adding an
 * address widens what can be sent unreviewed, so every mutation here says what
 * it changed and the command warns rather than staying quiet when a setting
 * looks like it will not work.
 *
 * Edits the same `~/.config/pai/config.json` the daemon reads, preserving
 * everything else in the file — including the `_comment` keys a user may have
 * left for themselves.
 */

import type { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { CONFIG_FILE } from "../../daemon/config.js";
import {
  normalizeEmail,
  checkDeliveryReachability,
  type IdentityLike,
} from "../../identity/index.js";
import { ok, err, warn, dim, bold } from "../utils.js";

interface ConfigShape {
  identity?: IdentityLike & { sendingAccountAliases?: string[] };
  [key: string]: unknown;
}

function readConfig(): ConfigShape {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as ConfigShape;
  } catch (e) {
    console.error(err("pai identity: ") + `Could not parse ${CONFIG_FILE}: ${String(e)}`);
    process.exit(1);
  }
}

/**
 * Write via a temp file and rename, so an interrupted write cannot leave the
 * config truncated. The daemon reads this file; a half-written one takes the
 * whole system down rather than just this command.
 */
function writeConfig(config: ConfigShape): void {
  const tmp = `${CONFIG_FILE}.identity.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tmp, CONFIG_FILE);
}

function identityOf(config: ConfigShape) {
  return config.identity ?? { selfEmails: [] };
}

function reportReachability(id: IdentityLike & { sendingAccountAliases?: string[] }): void {
  const v = checkDeliveryReachability(
    id.deliverTo,
    id.sendingAccount,
    id.sendingAccountAliases ?? []
  );
  if (v.verdict === "unreachable") {
    console.log(err("  Unreachable: ") + v.reason);
  } else if (v.verdict === "suspect") {
    console.log(warn("  Suspect: ") + v.reason);
  }
}

export function registerIdentityCommands(identityCmd: Command): void {
  identityCmd
    .command("show")
    .description("Show the configured identity")
    .action(() => {
      const id = identityOf(readConfig());
      const emails = id.selfEmails ?? [];

      console.log();
      console.log(bold("  Identity"));
      console.log();
      console.log(`  Deliver to:       ${id.deliverTo ?? dim("not set")}`);
      console.log(`  Sending account:  ${id.sendingAccount ?? dim("not set")}`);
      console.log();

      if (emails.length === 0) {
        console.log(warn("  No self addresses configured."));
        console.log(
          dim("  Nothing counts as your own address, so every mail is drafts-only.")
        );
        console.log(dim("  Add one with: pai identity add <email>"));
      } else {
        console.log(bold(`  Your own addresses (${emails.length}):`));
        for (const e of emails) console.log(`    ${e}`);
        console.log();
        console.log(
          dim("  Mail addressed only to these may be sent; anything else is a draft.")
        );
      }
      console.log();
      reportReachability(id);
      console.log();
    });

  identityCmd
    .command("add <email>")
    .description("Declare an address as your own (widens what can be sent unreviewed)")
    .action((email: string) => {
      const normalized = normalizeEmail(email);
      if (!normalized) {
        console.error(err("pai identity: ") + `Not a usable email address: ${email}`);
        process.exit(1);
      }

      const config = readConfig();
      const id = identityOf(config);
      const emails = (id.selfEmails ?? []).slice();

      if (emails.map(normalizeEmail).includes(normalized)) {
        console.log(dim(`  ${normalized} is already listed. Nothing changed.`));
        return;
      }

      emails.push(normalized);
      config.identity = { ...id, selfEmails: emails };
      writeConfig(config);

      console.log(ok("Added. ") + `${normalized} now counts as your own address.`);
      console.log(dim(`  Mail addressed only to your own addresses may now be sent unreviewed.`));
    });

  identityCmd
    .command("remove <email>")
    .description("Stop treating an address as your own")
    .action((email: string) => {
      const normalized = normalizeEmail(email);
      const config = readConfig();
      const id = identityOf(config);
      const before = id.selfEmails ?? [];
      const after = before.filter((e) => normalizeEmail(e) !== normalized);

      if (after.length === before.length) {
        console.log(dim(`  ${email} was not listed. Nothing changed.`));
        return;
      }

      config.identity = { ...id, selfEmails: after };
      writeConfig(config);
      console.log(ok("Removed. ") + `${email} is no longer treated as your own.`);
    });

  identityCmd
    .command("set-delivery <email>")
    .description("Set where digests and 'mail me X' are delivered")
    .action((email: string) => {
      const normalized = normalizeEmail(email);
      if (!normalized) {
        console.error(err("pai identity: ") + `Not a usable email address: ${email}`);
        process.exit(1);
      }

      const config = readConfig();
      const id = identityOf(config);
      config.identity = { ...id, deliverTo: normalized };
      writeConfig(config);

      console.log(ok("Delivery address set. ") + normalized);

      // Warn immediately rather than at send time. A delivery address that
      // cannot arrive fails silently — the send reports success — so the only
      // useful moment to say so is when it is being configured.
      reportReachability(config.identity);

      if (!(id.selfEmails ?? []).map(normalizeEmail).includes(normalized)) {
        console.log(
          warn("  Note: ") +
            `${normalized} is not in your self-address list, so mail to it would still be ` +
            `drafted rather than sent. Run: pai identity add ${normalized}`
        );
      }
    });
}
