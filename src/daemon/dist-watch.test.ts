import { describe, expect, it, vi } from "vitest";
import { createDistWatch, DIST_STABLE_MS } from "./dist-watch.js";

function setup() {
  const st = { id: "100" as string | undefined, t: 0, busy: false };
  const restart = vi.fn();
  const log = vi.fn();
  const tick = createDistWatch({ readId: () => st.id, now: () => st.t, busy: () => st.busy, restart, log });
  return { st, restart, log, tick };
}

describe("daemon dist watch", () => {
  it("does nothing when dist is unchanged", () => {
    const { st, restart, tick } = setup();
    for (let i = 0; i < 10; i++) {
      st.t += DIST_STABLE_MS;
      expect(tick()).toBe("idle");
    }
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts once after the debounce, logging old -> new", () => {
    const { st, restart, log, tick } = setup();
    st.id = "200";
    expect(tick()).toBe("settling");
    st.t += DIST_STABLE_MS - 1;
    expect(tick()).toBe("settling");
    st.t += 1;
    expect(tick()).toBe("restarting");
    tick();
    tick();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("DAEMON-SELF-RESTART reason=dist changed (100 -> 200)");
  });

  it("restarts the debounce when the build keeps changing", () => {
    const { st, restart, tick } = setup();
    st.id = "200";
    tick();
    st.t += DIST_STABLE_MS - 1;
    st.id = "300";
    expect(tick()).toBe("settling");
    st.t += DIST_STABLE_MS - 1;
    expect(tick()).toBe("settling");
    st.t += 1;
    expect(tick()).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("waits for a running pass, then restarts", () => {
    const { st, restart, tick } = setup();
    st.busy = true;
    st.id = "200";
    tick();
    st.t += DIST_STABLE_MS * 5;
    expect(tick()).toBe("waiting-pass");
    expect(restart).not.toHaveBeenCalled();
    st.busy = false;
    expect(tick()).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("ignores an unreadable dist (mid-build)", () => {
    const { st, restart, tick } = setup();
    st.id = undefined;
    st.t += DIST_STABLE_MS * 2;
    expect(tick()).toBe("idle");
    expect(restart).not.toHaveBeenCalled();
  });
});
