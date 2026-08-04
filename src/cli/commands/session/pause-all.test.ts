/**
 * `--only` selection for `pai pause all`.
 *
 * Added because the bug that prompted it — a send that could never work —
 * survived precisely because the only branch anyone ran was `--dry-run`, which
 * returns before sending. `--only` exists so the real path can be rehearsed
 * against one session before it is trusted with fifteen.
 *
 * A filter is the wrong place to be clever: matching nothing must be loud, and
 * matching more than intended must be impossible to do by accident.
 */

import { describe, it, expect } from "vitest";
import { matchesOnly } from "./pause-all.js";
import type { AiBrokerSessionMeta } from "../../lib/aibroker-client.js";

function session(over: Partial<AiBrokerSessionMeta> = {}): AiBrokerSessionMeta {
  return {
    sessionId: "7552A02E-E322-4891-82E9-BCD6778B068D",
    name: "Home",
    kind: "claude",
    ...over,
  } as AiBrokerSessionMeta;
}

describe("matchesOnly", () => {
  it("matches on the session name", () => {
    expect(matchesOnly(session(), "Home")).toBe(true);
  });

  it("ignores case", () => {
    // The registry already holds `Clickr`/`clickr` and `Paperfull`/`paperfull`
    // pairs, so case-sensitivity here would silently miss half of them.
    expect(matchesOnly(session(), "home")).toBe(true);
    expect(matchesOnly(session({ name: "PAI" }), "pai")).toBe(true);
  });

  it("prefers the PAI name over the raw terminal name", () => {
    const s = session({ name: "zsh", paiName: "Solar" });
    expect(matchesOnly(s, "Solar")).toBe(true);
  });

  it("matches on a session id prefix, as shown in the listing", () => {
    // The output prints the first 8 characters, so that is what a human copies.
    expect(matchesOnly(session(), "7552A02E")).toBe(true);
  });

  it("does not match an unrelated name", () => {
    expect(matchesOnly(session(), "Glidr")).toBe(false);
  });

  it("treats a blank filter as no filter rather than as matching nothing", () => {
    // `--only ""` should not silently pause zero sessions and report success.
    expect(matchesOnly(session(), "   ")).toBe(true);
  });
});
