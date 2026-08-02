import { describe, it, expect } from "vitest";
import { resolveOwner, ownerLabel, hasDefaultMarker } from "./resolver.js";
import type { AliasMap } from "./resolver.js";

/**
 * The tracker's projects mirror PAI projects; the alias map is what connects
 * a container or label name to one.
 */
const ALIASES: AliasMap = new Map([
  ["broker", { alias: "broker", rootPath: "/dev/ai/AIBroker" }],
  ["clickr", { alias: "clickr", rootPath: "/dev/ai/clickr" }],
  // Keys are normalize()d: non-alphanumeric runs become hyphens, so the
  // container "Jobs Matthias" and the label "pai:jobs matthias" both land here.
  ["jobs-matthias", { alias: "jobs-matthias", rootPath: "/Job Search" }],
]) as AliasMap;

describe("resolveOwner — the project decides", () => {
  /**
   * Reported 2026-08-02: a task was moved from Clickr to AIBroker in the
   * tracker UI and a comment on it was delivered to Clickr, because a label
   * from its old home outranked the project it now sat in. The user had not
   * seen the label and had not used labels in months.
   *
   * A task sits in exactly ONE project and can carry MANY labels, so a
   * multi-valued field cannot be the authoritative owner — with two `pai:`
   * labels there is no principled winner, only whichever the code sees first.
   */
  it("follows the container even when a stale label names somewhere else", () => {
    const owner = resolveOwner(
      { labels: ["pai:clickr"], container: "broker" },
      ALIASES
    );
    expect(owner.project).toBe("broker");
    expect(owner.source).toBe("container");
  });

  it("ignores a bare label that names a different project", () => {
    // The exact shape of the live bug: label `clickr`, project AIBroker.
    const owner = resolveOwner({ labels: ["clickr"], container: "broker" }, ALIASES);
    expect(owner.project).toBe("broker");
  });

  it("still uses a label when the container names nothing routable", () => {
    // The case labels are genuinely good at: a task parked somewhere with no
    // owner of its own, addressed deliberately.
    const owner = resolveOwner(
      { labels: ["pai:jobs matthias"], container: "Reading List 📚" },
      ALIASES
    );
    expect(owner.project).toBe("jobs-matthias");
    expect(owner.source).toBe("label");
  });

  it("uses a label when there is no container at all", () => {
    const owner = resolveOwner({ labels: ["pai:broker"], container: null }, ALIASES);
    expect(owner.project).toBe("broker");
  });

  it("reports what it tried when nothing resolves", () => {
    // Unroutable is a normal state, not an error — but it must say why, so a
    // routine can explain itself rather than dropping the task silently.
    const owner = resolveOwner({ labels: [], container: "Reading List 📚" }, ALIASES);
    expect(owner.project).toBeNull();
    expect(owner.rawHint).toBe("Reading List 📚");
  });

  it("surfaces a label naming a project that does not exist", () => {
    const owner = resolveOwner({ labels: ["pai:ghost"], container: null }, ALIASES);
    expect(owner.project).toBeNull();
    expect(owner.rawHint).toBe("ghost");
  });
});

describe("the bare `pai` marker", () => {
  /**
   * The one thing a task's location cannot express: "an AI should take this,
   * and I do not know which one yet". Previously a bare `pai` was a near miss —
   * it looked like an address and resolved to nothing — which made the most
   * natural thing to type the one thing that silently did nothing.
   */
  it("is recognised, and distinguished from pai:<name>", () => {
    expect(hasDefaultMarker(["pai"])).toBe(true);
    expect(hasDefaultMarker([" PAI "])).toBe(true);
    expect(hasDefaultMarker(["pai:broker"])).toBe(false);
    expect(hasDefaultMarker(["paint"])).toBe(false);
    expect(hasDefaultMarker([])).toBe(false);
  });

  it("routes an Inbox capture to the default owner", () => {
    const owner = resolveOwner(
      { labels: ["pai"], container: null, defaultOwner: "broker" },
      ALIASES
    );
    expect(owner.project).toBe("broker");
  });

  it("never outranks a container that resolves", () => {
    // The marker means "decide for me". A project that names an owner has
    // already decided.
    const owner = resolveOwner(
      { labels: ["pai"], container: "jobs matthias", defaultOwner: "broker" },
      ALIASES
    );
    expect(owner.project).toBe("jobs-matthias");
  });

  it("never outranks an explicit pai:<name> label", () => {
    const owner = resolveOwner(
      { labels: ["pai", "pai:clickr"], container: null, defaultOwner: "broker" },
      ALIASES
    );
    expect(owner.project).toBe("clickr");
  });

  it("leaves the task unrouted when no default is configured", () => {
    // Deliberate: guessing an owner for a task nobody addressed is worse than
    // letting it surface in the findings inbox for triage.
    const owner = resolveOwner({ labels: ["pai"], container: null }, ALIASES);
    expect(owner.project).toBeNull();
  });
});

describe("ownerLabel", () => {
  it("reads the first pai: label and ignores others", () => {
    expect(ownerLabel(["urgent", "pai:broker", "pai:clickr"])).toBe("broker");
  });

  it("ignores a bare pai, which names no owner", () => {
    expect(ownerLabel(["pai"])).toBeNull();
  });
});
