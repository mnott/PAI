import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RequestScheduler } from "../router/scheduler.js";
import { DEFAULT_HELPER, helperComplete, helperConfig, helperStats, resetHelperState, truncateInput, type HelperDeps, type WireRequest } from "./helper.js";
import { cachedTldr, classifyAlert, cleanGateSummary, cleanTldr, parseAlertVerdict, resetTldrState } from "./helper-uses.js";

const msg = (text: string): string => JSON.stringify({ content: [{ type: "text", text }] });
const ollama = (text: string): string => JSON.stringify({ message: { content: text } });

function deps(fetch: HelperDeps["fetch"], over: Partial<HelperDeps> = {}): HelperDeps {
  return {
    config: { ...DEFAULT_HELPER },
    logDir: mkdtempSync(join(tmpdir(), "helper-")),
    routerUrl: "http://127.0.0.1:1",
    routerModel: (n) => (n === "apple-fm" ? "apple-fm" : null),
    fetch,
    ...over,
  };
}

beforeEach(() => {
  resetHelperState();
  resetTldrState();
});

describe("truncateInput", () => {
  it("keeps the tail of a log, the head of prose", () => {
    const s = "a".repeat(50) + "TAIL";
    expect(truncateInput(s, 10).endsWith("aaaaaaTAIL")).toBe(true);
    expect(truncateInput(s, 10)).toContain("truncated");
    expect(truncateInput("HEAD" + s, 10, "head").startsWith("HEADaaaaaa")).toBe(true);
    expect(truncateInput("short", 10)).toBe("short");
  });
});

describe("helperComplete", () => {
  it("asks apple-fm through the router at low priority and records the call", async () => {
    let seen: WireRequest | undefined;
    const d = deps(async (w) => ((seen = w), msg("ok")));
    expect(await helperComplete({ task: "t", input: "i", label: "alert" }, d)).toBe("ok");
    expect(seen?.url).toBe("http://127.0.0.1:1/v1/messages");
    expect(seen?.headers["x-pai-priority"]).toBe("low");
    const st = helperStats(d);
    expect(st.models["apple-fm"].perHour).toBe(1);
    expect(st.models["apple-fm"].fallbacks).toBe(0);
  });

  it("returns null on timeout or error everywhere (no cloud fallback), counted as fallbacks", async () => {
    const urls: string[] = [];
    const d = deps(async (w) => {
      urls.push(w.url);
      throw new Error("aborted");
    });
    expect(await helperComplete({ task: "t", input: "i" }, d)).toBeNull();
    expect(urls.every((u) => u.includes("127.0.0.1"))).toBe(true);
    expect(helperStats(d).models["apple-fm"].fallbacks).toBe(1);
  });

  it("skips a model that just failed and falls to the next one", async () => {
    let n = 0;
    const d = deps(async (w) => {
      n++;
      if (w.kind === "messages") throw new Error("down");
      return ollama("from ollama");
    });
    expect(await helperComplete({ task: "t", input: "i" }, d)).toBe("from ollama");
    n = 0;
    expect(await helperComplete({ task: "t", input: "i" }, d)).toBe("from ollama");
    expect(n).toBe(1); // apple-fm is cooling down, not retried
  });

  it("never routes a non-local provider name", async () => {
    let called = 0;
    const d = deps(async () => (called++, msg("x")), { config: { ...DEFAULT_HELPER, models: ["cloud-thing"] } });
    expect(await helperComplete({ task: "t", input: "i" }, d)).toBeNull();
    expect(called).toBe(0);
  });

  it("has at most one request in flight", async () => {
    let live = 0;
    let peak = 0;
    const d = deps(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return msg("ok");
    });
    await Promise.all([1, 2, 3].map(() => helperComplete({ task: "t", input: "i" }, d)));
    expect(peak).toBe(1);
  });

  it("sends only the truncated tail of an over-long input", async () => {
    let body = "";
    const d = deps(async (w) => ((body = w.body), msg("ok")), { config: { ...DEFAULT_HELPER, maxInputChars: 20 } });
    await helperComplete({ task: "t", input: "x".repeat(500) + "THE-END" }, d);
    expect(body).toContain("THE-END");
    expect(body.length).toBeLessThan(900);
  });

  it("is off when helper.enabled is false", async () => {
    let called = 0;
    const d = deps(async () => (called++, msg("x")), { config: { ...DEFAULT_HELPER, enabled: false } });
    expect(await helperComplete({ task: "t", input: "i" }, d)).toBeNull();
    expect(called).toBe(0);
  });
});

describe("priority lane", () => {
  it("serves an interactive request before a queued helper request", async () => {
    const s = new RequestScheduler();
    const order: string[] = [];
    const holder = await s.acquire("apple-fm", "s", "holder", { onAbort: () => {} });
    const low = s.acquire("apple-fm", "pai-helper", "pai-helper", { onAbort: () => {} }, "low").then((t) => (order.push("helper"), t.release()));
    const live = s.acquire("apple-fm", "app", "app", { onAbort: () => {} }).then((t) => (order.push("interactive"), t.release()));
    holder.release();
    await Promise.all([low, live]);
    expect(order).toEqual(["interactive", "helper"]);
  });
});

describe("uses fall back to rules", () => {
  it("parses a verdict and rejects junk", () => {
    expect(parseAlertVerdict("harness: server returned 500")).toEqual({ cls: "harness", reason: "server returned 500" });
    expect(parseAlertVerdict("I think so")).toBeNull();
  });

  it("classifyAlert is null when the model is down or switched off", async () => {
    const down = deps(async () => {
      throw new Error("down");
    });
    expect(await classifyAlert({ signature: "s", sample: "e" }, down)).toBeNull();
    const off = deps(async () => msg("model: x"), { config: { ...DEFAULT_HELPER, uses: { ...DEFAULT_HELPER.uses, toolErrors: false } } });
    expect(await classifyAlert({ signature: "s", sample: "e" }, off)).toBeNull();
    resetHelperState();
    const on = deps(async () => msg("model: asked for a missing tool"));
    expect(await classifyAlert({ signature: "s", sample: "e" }, on)).toEqual({ cls: "model", reason: "asked for a missing tool" });
  });

  it("a harness verdict needs a PAI marker in the error, else the record stays unknown", async () => {
    const noMarker = deps(async () => msg("harness: configuration file parsing error in worker script"));
    expect(await classifyAlert({ signature: "Bash|Exit code <N> Unmatched ) in regex", sample: "Unmatched ) in regex; marked by <-- HERE in m/( )/" }, noMarker)).toBeNull();
    resetHelperState();
    const guard = deps(async () => msg("harness: the guard itself threw"));
    expect(await classifyAlert({ signature: "s", sample: "PAI guard: internal error" }, guard)).toEqual({ cls: "harness", reason: "the guard itself threw" });
  });

  it("cachedTldr returns null at first (caller keeps first sentences), then the cached text", async () => {
    const d = deps(async () => msg("Adds a helper for small tasks. It runs on the local model."));
    expect(cachedTldr(d.logDir!, "job1", "spec text", d)).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(cachedTldr(d.logDir!, "job1", "spec text", d)).toBe("Adds a helper for small tasks. It runs on the local model.");
    expect(existsSync(join(d.logDir!, "job1.tldr"))).toBe(true);
  });

  it("cachedTldr stays null when the model fails", async () => {
    const d = deps(async () => {
      throw new Error("down");
    });
    cachedTldr(d.logDir!, "job2", "spec text", d);
    await new Promise((r) => setTimeout(r, 30));
    expect(cachedTldr(d.logDir!, "job2", "spec text", d)).toBeNull();
  });

  it("cleaners cut to the asked shape", () => {
    expect(cleanTldr("One is here for you. Two follows it. Three is extra.")).toBe("One is here for you. Two follows it.");
    expect(cleanGateSummary("1. a\n2. b\n3. c\n4. d")).toBe("a\nb\nc");
  });

  it("config defaults", () => {
    expect(helperConfig({}).models).toEqual(["apple-fm", "ollama:qwen3:8b"]);
    expect(helperConfig({ uses: { tldr: false } }).uses.tldr).toBe(false);
  });
});
