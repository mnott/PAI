import { describe, expect, it, vi } from "vitest";
import { armResultGrace, leftoverNote } from "./result-grace.js";

function deps() {
  const terminate = vi.fn(async () => undefined);
  return { terminate, d: { descendants: () => [11, 12], terminate } };
}

describe("armResultGrace", () => {
  it("does not kill when the process exits within the grace", () => {
    vi.useFakeTimers();
    const { terminate, d } = deps();
    const g = armResultGrace(10, 20_000, d);
    g.onResult();
    vi.advanceTimersByTime(5_000);
    g.cancel(); // close handler
    vi.advanceTimersByTime(60_000);
    expect(terminate).not.toHaveBeenCalled();
    expect(g.fired).toBe(false);
    vi.useRealTimers();
  });

  it("terminates the tree after the grace when the process stays alive", async () => {
    vi.useFakeTimers();
    const { terminate, d } = deps();
    const g = armResultGrace(10, 20_000, d);
    g.onResult();
    vi.advanceTimersByTime(19_999);
    expect(terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(terminate).toHaveBeenCalledWith(10);
    expect(g.fired).toBe(true);
    expect(g.leftover).toBe(2);
    await g.settled();
    expect(leftoverNote(g.leftover)).toBe("finished; ended 2 leftover background process(es)");
    vi.useRealTimers();
  });

  it("operator input cancels the clock", () => {
    vi.useFakeTimers();
    const { terminate, d } = deps();
    const g = armResultGrace(10, 20_000, d);
    g.onResult();
    g.cancel();
    vi.advanceTimersByTime(60_000);
    expect(terminate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
