/**
 * `pai identity` — declare who "me" is.
 *
 * The list this edits is an allowlist for actions that reach the outside world
 * without review, outbound mail being the case it was built for. Adding an
 * address widens what can be sent unreviewed, so every mutation here says what
 * it changed and the command warns rather than staying quiet when a setting
 * looks like it will not work.
 *
 * Edits the same PAI config file (`pai config path`) the daemon reads, preserving
 * everything else in the file — including the `_comment` keys a user may have
 * left for themselves.
 */

import { readMainConfigRaw, writeMainConfigRaw, paiConfigFilePath } from "../../daemon/config.js";
import {
  normalizeEmail,
  checkDeliveryReachability,
  type IdentityLike,
} from "../../identity/index.js";
import { ok, err, warn, dim, bold } from "../lib/utils.js";

interface ConfigShape {
  identity?: IdentityLike & { sendingAccountAliases?: string[] };
  [key: string]: unknown;
}

/** Null after printing the error: the caller exits 1. */
function readConfig(): ConfigShape | null {
  try {
    return readMainConfigRaw() as ConfigShape;
  } catch (e) {
    console.error(err("pai identity: ") + `Could not read ${paiConfigFilePath()}: ${String(e)}`);
    return null;
  }
}

/** Writes through writeMainConfigRaw — comment-preserving into config.yaml
 *  when it exists, else atomic into config.json. */
function writeConfig(config: ConfigShape): void {
  writeMainConfigRaw(config);
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

export function identityShow(): number {
  const config = readConfig();
  if (!config) return 1;
  const id = identityOf(config);
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
  return 0;
}

export function identityAdd(email: string): number {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    console.error(err("pai identity: ") + `Not a usable email address: ${email}`);
    return 1;
  }

  const config = readConfig();
  if (!config) return 1;
  const id = identityOf(config);
  const emails = (id.selfEmails ?? []).slice();

  if (emails.map(normalizeEmail).includes(normalized)) {
    console.log(dim(`  ${normalized} is already listed. Nothing changed.`));
    return 0;
  }

  emails.push(normalized);
  config.identity = { ...id, selfEmails: emails };
  writeConfig(config);

  console.log(ok("Added. ") + `${normalized} now counts as your own address.`);
  console.log(dim(`  Mail addressed only to your own addresses may now be sent unreviewed.`));
  return 0;
}

export function identityRemove(email: string): number {
  const normalized = normalizeEmail(email);
  const config = readConfig();
  if (!config) return 1;
  const id = identityOf(config);
  const before = id.selfEmails ?? [];
  const after = before.filter((e) => normalizeEmail(e) !== normalized);

  if (after.length === before.length) {
    console.log(dim(`  ${email} was not listed. Nothing changed.`));
    return 0;
  }

  config.identity = { ...id, selfEmails: after };
  writeConfig(config);
  console.log(ok("Removed. ") + `${email} is no longer treated as your own.`);
  return 0;
}

export function identitySetDelivery(email: string): number {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    console.error(err("pai identity: ") + `Not a usable email address: ${email}`);
    return 1;
  }

  const config = readConfig();
  if (!config) return 1;
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
  return 0;
}
