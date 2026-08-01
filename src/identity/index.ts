/**
 * Who "me" is.
 *
 * One question is asked of this module: **is this address the user's own?**
 * It exists because the alternative is an assistant deciding that per message,
 * from context, at the moment it is about to act — and "that looks like his
 * address" is not a judgement worth re-making every time. Here it is a lookup
 * against a list the user maintains.
 *
 * The rule the list serves: a mail whose recipients are all the user's own may
 * be sent; anything else is a draft for review. So a false positive here means
 * mail leaving without review. Everything below is written to fail closed —
 * an empty list means nothing is self-addressed, an unparseable address is not
 * self-addressed, and no pattern is ever inferred.
 *
 * Aliases are NOT matched by pattern, deliberately. `matthias.nott+x@gmail.com`
 * and `matthias.nott@gmail.com` are the same mailbox, and Gmail also ignores
 * dots — but the general forms of those rules ("same local part before a plus",
 * "same domain") also match addresses belonging to other people. Gmail's own
 * normalisation is Gmail's; other providers treat `+` and `.` as ordinary
 * characters, and `first.last@company.com` is a different person from
 * `firstlast@company.com`. Anything that should count gets listed.
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Reduce an address to a comparable form: trimmed, unwrapped, lowercased.
 *
 * Handles `Display Name <addr@example.com>` because recipient fields carry that
 * form routinely. Returns null when there is nothing usable, which callers
 * treat as "not the user's" rather than as an error — an address that cannot be
 * parsed is one whose ownership cannot be established.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let value = raw.trim();
  if (!value) return null;

  const angled = value.match(/<([^>]*)>/);
  if (angled) value = angled[1].trim();

  value = value.toLowerCase();

  // Must look like an address at all: exactly one @, with something either side
  // and a dot in the domain. This is a sanity check, not validation — its job
  // is to reject junk before it can be compared, not to police correctness.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return null;

  return value;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export interface IdentityLike {
  selfEmails?: string[];
  deliverTo?: string;
  sendingAccount?: string;
}

/** Is this address one the user has declared as their own? */
export function isSelfAddress(address: string, identity: IdentityLike | undefined): boolean {
  const candidate = normalizeEmail(address);
  if (!candidate) return false;

  const own = (identity?.selfEmails ?? [])
    .map(normalizeEmail)
    .filter((e): e is string => e !== null);

  return own.includes(candidate);
}

/**
 * May a mail to these recipients be sent without review?
 *
 * Every recipient must be the user's own — To, Cc and Bcc together, since a
 * single outsider on Bcc is still an outsider. An empty recipient list is not
 * permission: there is nothing to check, so it is refused.
 *
 * Returns the offending addresses rather than a bare false, so the caller can
 * say which recipient forced the draft instead of reporting a flat refusal.
 */
export interface SendDecision {
  allowed: boolean;
  /** Recipients that are not the user's own. Empty when allowed. */
  foreign: string[];
  reason: string;
}

export function maySendWithoutReview(
  recipients: Array<string | null | undefined>,
  identity: IdentityLike | undefined
): SendDecision {
  const listed = recipients.filter((r): r is string => Boolean(r && r.trim()));

  if (listed.length === 0) {
    return { allowed: false, foreign: [], reason: "No recipients to check" };
  }

  if (!identity?.selfEmails?.length) {
    return {
      allowed: false,
      foreign: listed,
      reason:
        "No identity.selfEmails configured — nothing counts as your own address yet. " +
        "Run `pai identity add <email>`.",
    };
  }

  const foreign = listed.filter((r) => !isSelfAddress(r, identity));

  if (foreign.length > 0) {
    return {
      allowed: false,
      foreign,
      reason: `Not your own address: ${foreign.join(", ")} — draft for review instead`,
    };
  }

  return { allowed: true, foreign: [], reason: "All recipients are your own address" };
}

// ---------------------------------------------------------------------------
// Delivery reachability
// ---------------------------------------------------------------------------

/**
 * Would a mail from `sendingAccount` to `deliverTo` actually reach an inbox?
 *
 * Gmail files a message sent from an account to itself, or to one of its own
 * domain aliases, under Sent only — it never appears in the inbox. The send
 * reports success, so the failure is invisible and indistinguishable from
 * delivery. This cost a real digest on 2026-08-01: mnott@mnott.ch →
 * mnott@mnott.de, sent cleanly, never seen.
 *
 * Detecting it in general is not possible from the addresses alone — whether
 * two addresses are the same Google account is a fact about the account, not
 * about their spelling. So this reports what it can see and says so plainly:
 * an exact match is certain, a shared domain is suspicious and worth warning
 * about, and anything else is unknown rather than fine.
 */
export type Reachability = "unreachable" | "suspect" | "unknown";

export interface ReachabilityVerdict {
  verdict: Reachability;
  reason: string;
}

export function checkDeliveryReachability(
  deliverTo: string | undefined,
  sendingAccount: string | undefined,
  sendingAccountAliases: string[] = []
): ReachabilityVerdict {
  const to = normalizeEmail(deliverTo);
  const from = normalizeEmail(sendingAccount);

  if (!to || !from) {
    return { verdict: "unknown", reason: "Delivery address or sending account not configured" };
  }

  if (to === from) {
    return {
      verdict: "unreachable",
      reason:
        `${to} is the sending account itself. Gmail files self-sends under Sent only — ` +
        `the send will report success and never reach the inbox.`,
    };
  }

  // The declared alias list is the only reliable signal, and it is why the list
  // exists. The case that actually cost a digest was mnott@mnott.ch sending to
  // mnott@mnott.de — one Google account behind two DIFFERENT domains, which no
  // comparison of the addresses themselves can reveal. Whether two addresses
  // are one mailbox is a fact about the account, not about their spelling.
  const aliases = sendingAccountAliases
    .map(normalizeEmail)
    .filter((e): e is string => e !== null);

  if (aliases.includes(to)) {
    return {
      verdict: "unreachable",
      reason:
        `${to} is a declared alias of the sending account (${from}). The send will report ` +
        `success and never reach the inbox. Deliver by adding the INBOX label to the ` +
        `written message instead.`,
    };
  }

  const toDomain = to.slice(to.indexOf("@") + 1);
  const fromDomain = from.slice(from.indexOf("@") + 1);

  if (toDomain === fromDomain) {
    return {
      verdict: "suspect",
      reason:
        `${to} shares a domain with the sending account (${from}). If it is an alias of the ` +
        `same account the send will silently not arrive. Deliver by adding the INBOX label ` +
        `to the written message rather than relying on the send path.`,
    };
  }

  // Deliberately not "fine". Cross-domain aliases of one account look exactly
  // like this and are undetectable here — which is why label-based delivery is
  // the safe default even when this returns unknown.
  return {
    verdict: "unknown",
    reason:
      "Separate domains and not a declared alias — no suppression predictable from the " +
      "addresses alone, which is not the same as delivery being guaranteed.",
  };
}
