import { describe, expect, it } from "vitest";
import { ancestorTty, resolveHostSession, type HostDeps } from "./pane.js";

const LIVE = "88D76B26-0000-0000-0000-000000000001";
const DEAD = "78C67D79-0000-0000-0000-000000000002";

function deps(procs: Record<number, [number, string]>, sessions: Array<{ id: string; tty: string }>): HostDeps {
  return { psOf: (pid) => procs[pid] ?? null, listSessions: async () => sessions };
}

const chain = { [500]: [400, "??"], [400]: [300, "ttys004"], [300]: [1, "ttys004"] } as Record<number, [number, string]>;

describe("resolveHostSession", () => {
  it("tty match beats a stale ITERM_SESSION_ID", async () => {
    const h = await resolveHostSession(
      { ITERM_SESSION_ID: `w1t0p0:${DEAD}` },
      deps(chain, [{ id: LIVE, tty: "/dev/ttys004" }]),
      500,
    );
    expect(h).toMatchObject({ uid: LIVE, term: LIVE, via: "tty" });
  });

  it("keeps the env value as term when it names the tty session", async () => {
    const env = { ITERM_SESSION_ID: `w1t0p0:${LIVE}` };
    const h = await resolveHostSession(env, deps(chain, [{ id: LIVE, tty: "/dev/ttys004" }]), 500);
    expect(h).toMatchObject({ uid: LIVE, term: env.ITERM_SESSION_ID, via: "tty" });
  });

  it("no tty ancestor + live env id -> env id", async () => {
    const env = { ITERM_SESSION_ID: `w1t0p0:${LIVE}` };
    const h = await resolveHostSession(env, deps({ 500: [1, "??"] }, [{ id: LIVE, tty: "/dev/ttys009" }]), 500);
    expect(h).toMatchObject({ uid: LIVE, via: "env" });
  });

  it("nothing resolves -> loud reason", async () => {
    const h = await resolveHostSession(
      { ITERM_SESSION_ID: `w1t0p0:${DEAD}` },
      deps({ 500: [1, "??"] }, [{ id: LIVE, tty: "/dev/ttys009" }]),
      500,
    );
    expect(h.via).toBe("none");
    expect(h.uid).toBe("");
    expect(h.reason).toContain(`${DEAD} is not live`);
    expect(h.reason).toContain("no tty ancestor");
  });
});

describe("ancestorTty", () => {
  it("skips ?? ttys up to the first real one", () => {
    expect(ancestorTty(deps(chain, []), 500)).toBe("/dev/ttys004");
  });
  it("null when the whole chain is ??", () => {
    expect(ancestorTty(deps({ 500: [400, "??"], 400: [1, "??"] }, []), 500)).toBeNull();
  });
});
