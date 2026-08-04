import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  isSelfAddress,
  maySendWithoutReview,
  checkDeliveryReachability,
} from "./index.js";

const IDENTITY = {
  selfEmails: ["owner.name@example.com", "owner@example.de", "owner@example.ch"],
  deliverTo: "owner.name@example.com",
  sendingAccount: "owner@example.de",
};

describe("normalizeEmail", () => {
  it("unwraps a display-name form and lowercases", () => {
    expect(normalizeEmail("Owner Name <Owner@Example.CH>")).toBe("owner@example.ch");
  });

  it("rejects junk rather than passing it through", () => {
    for (const junk of ["", "   ", "not-an-address", "a@b", "two@at@signs.com", null, undefined]) {
      expect(normalizeEmail(junk)).toBeNull();
    }
  });
});

describe("isSelfAddress", () => {
  it("matches a listed address regardless of case or wrapping", () => {
    expect(isSelfAddress("  Owner@example.de ", IDENTITY)).toBe(true);
    expect(isSelfAddress("the owner <owner.name@example.com>", IDENTITY)).toBe(true);
  });

  it("does NOT infer plus-aliases", () => {
    // Same Gmail mailbox in practice, but the general rule that would match it
    // also matches other people's addresses. It has to be listed.
    expect(isSelfAddress("owner.name+tag@example.com", IDENTITY)).toBe(false);
  });

  it("does NOT treat a shared domain as ownership", () => {
    expect(isSelfAddress("third.party@example.ch", IDENTITY)).toBe(false);
  });

  it("owns nothing when no identity is configured", () => {
    expect(isSelfAddress("owner.name@example.com", undefined)).toBe(false);
    expect(isSelfAddress("owner.name@example.com", { selfEmails: [] })).toBe(false);
  });
});

describe("maySendWithoutReview", () => {
  it("allows a mail addressed entirely to the user", () => {
    const d = maySendWithoutReview(["owner@example.de", "owner.name@example.com"], IDENTITY);
    expect(d.allowed).toBe(true);
    expect(d.foreign).toEqual([]);
  });

  it("refuses when ONE recipient among many is not the user", () => {
    // The case the rule exists for: a bcc'd outsider on an otherwise self-addressed mail.
    const d = maySendWithoutReview(
      ["owner@example.de", "owner.name@example.com", "someone@example.com"],
      IDENTITY
    );
    expect(d.allowed).toBe(false);
    expect(d.foreign).toEqual(["someone@example.com"]);
  });

  it("refuses an empty recipient list rather than treating it as vacuously safe", () => {
    expect(maySendWithoutReview([], IDENTITY).allowed).toBe(false);
    expect(maySendWithoutReview([null, undefined, "  "], IDENTITY).allowed).toBe(false);
  });

  it("fails closed when identity is unconfigured", () => {
    const d = maySendWithoutReview(["owner.name@example.com"], { selfEmails: [] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("pai identity add");
  });
});

describe("checkDeliveryReachability", () => {
  it("calls out delivery to the sending account itself", () => {
    const v = checkDeliveryReachability("owner@example.de", "owner@example.de");
    expect(v.verdict).toBe("unreachable");
    expect(v.reason).toContain("Sent only");
  });

  it("catches the case that actually bit, via the declared alias list", () => {
    // Observed 2026-08-01: sent cleanly from owner@example.ch to owner@example.de,
    // reported success, never arrived. Two DIFFERENT domains on one Google
    // account — so nothing about the addresses reveals it and only the
    // declared alias list can.
    const v = checkDeliveryReachability("owner@example.de", "owner@example.ch", [
      "owner@example.de",
      "owner@example.org",
    ]);
    expect(v.verdict).toBe("unreachable");
    expect(v.reason).toContain("INBOX label");
  });

  it("without the alias list, that same pair is NOT detectable", () => {
    // Pinning the limitation rather than pretending it away: this is why
    // label-based delivery is the safe default even on an "unknown" verdict.
    expect(checkDeliveryReachability("owner@example.de", "owner@example.ch").verdict).toBe("unknown");
  });

  it("flags a shared domain as suspect", () => {
    const v = checkDeliveryReachability("alias@example.ch", "owner@example.ch");
    expect(v.verdict).toBe("suspect");
    expect(v.reason).toContain("INBOX label");
  });

  it("does not claim separate domains are fine, only that nothing is predictable", () => {
    expect(checkDeliveryReachability("owner.name@example.com", "owner@example.de").verdict).toBe(
      "unknown"
    );
  });

  it("is unknown when either side is missing", () => {
    expect(checkDeliveryReachability(undefined, "owner@example.de").verdict).toBe("unknown");
    expect(checkDeliveryReachability("a@b.com", undefined).verdict).toBe("unknown");
  });
});
