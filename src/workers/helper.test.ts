import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RequestScheduler } from "../router/scheduler.js";
import { readFileSync } from "node:fs";
import { DEFAULT_HELPER, HELPER_CALLS_FILE, resolveHelperSpecs, configuredHelperSpecs, helperSetupWarning, helperReport, helperComplete, helperConfig, helperStats, resetHelperState, truncateInput, type HelperCall, type HelperDeps, type WireRequest } from "./helper.js";
import { classifyRouteAssisted } from "./route-classifier.js";
import { parseProofVerdict, proofIsEmpty, routeSecondOpinion, cachedTldr, classifyAlert, cleanGateSummary, cleanTldr, parseAlertVerdict, resetTldrState, trimTldrInput } from "./helper-uses.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import { helperPickTopic, parseTopicWord, pickTopicAsync, resolveTopic, resetTopicPickState, TOPIC_WORDS } from "./topic.js";

const msg = (text: string): string => JSON.stringify({ content: [{ type: "text", text }] });
const ollama = (text: string): string => JSON.stringify({ message: { content: text } });

function deps(fetch: HelperDeps["fetch"], over: Partial<HelperDeps> = {}): HelperDeps {
  return {
    config: { ...DEFAULT_HELPER, models: ["apple-fm", "ollama:qwen3:8b"] },
    logDir: mkdtempSync(join(tmpdir(), "helper-")),
    routerUrl: "http://127.0.0.1:1",
    routerModel: (n) => (n === "apple-fm" ? "apple-fm" : null),
    fetch,
    ...over,
  };
}

const callsOf = (d: HelperDeps): HelperCall[] =>
  readFileSync(join(d.logDir!, HELPER_CALLS_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as HelperCall);

beforeEach(() => {
  resetHelperState();
  resetTldrState();
  resetTopicPickState();
});

const workerStatus = (id: string): WorkerStatus => ({
  id,
  pid: 1,
  runPid: 1,
  procStart: 1,
  label: "some task",
  cwd: "/tmp",
  term: "",
  provider: "gyro-l",
  model: "m",
  state: "running",
  started: "2026-11-19 00:00:00",
  updated: "2026-11-19 00:00:00",
  turns: 0,
  tools: 0,
  last: "x",
  rc: null,
  secs: null,
  origin: "spawn",
  outputFormat: "json",
});

const LONG_SPEC = "Add a helper for small tasks that runs on the local model. " + "Details of the work follow here. ".repeat(10);

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

  it("a failed call names its kind on the log line: timeout, error, empty; a rejected answer says rejected", async () => {
    const timed = deps(async () => {
      throw new Error("This operation was aborted");
    });
    await helperComplete({ task: "t", input: "i", label: "tldr" }, timed);
    expect(callsOf(timed)[0].kind).toBe("timeout");
    resetHelperState();
    const broken = deps(async () => {
      throw new Error("HTTP 500");
    });
    await helperComplete({ task: "t", input: "i", label: "tldr" }, broken);
    expect(callsOf(broken)[0].kind).toBe("error");
    resetHelperState();
    const blank = deps(async () => msg("   "));
    await helperComplete({ task: "t", input: "i", label: "alert" }, blank);
    expect(callsOf(blank)[0]).toMatchObject({ ok: false, kind: "empty" });
  });

  it("cachedTldr returns null at first (caller keeps first sentences), then the cached text", async () => {
    const d = deps(async () => msg("Adds a helper for small tasks. It runs on the local model."));
    expect(cachedTldr(d.logDir!, "job1", LONG_SPEC, d)).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(cachedTldr(d.logDir!, "job1", LONG_SPEC, d)).toBe("Adds a helper for small tasks. It runs on the local model.");
    expect(existsSync(join(d.logDir!, "job1.tldr"))).toBe(true);
  });

  it("cachedTldr: a short input is its own TL;DR, no model call, logged skipped-short (#31)", async () => {
    let n = 0;
    const d = deps(async () => {
      n++;
      return msg("ok");
    });
    const short = "  Rename the foo flag to bar in the CLI.  ";
    expect(cachedTldr(d.logDir!, "sh1", short, d)).toBe("Rename the foo flag to bar in the CLI.");
    expect(n).toBe(0);
    expect(cachedTldr(d.logDir!, "sh1", short, d)).toBe("Rename the foo flag to bar in the CLI.");
    expect(callsOf(d)[0]).toMatchObject({ label: "tldr", ok: true, kind: "skipped-short" });
    // acknowledgement-sized: nothing summarised, nothing cached
    expect(cachedTldr(d.logDir!, "sh2", "ok", d)).toBeNull();
    expect(existsSync(join(d.logDir!, "sh2.tldr"))).toBe(false);
    expect(n).toBe(0);
    expect(helperStats(d).models["apple-fm"]?.fallbacks ?? 0).toBe(0);
  });

  it("cachedTldr: a long input makes one model call; the real prompt shape reaches the model with the text", async () => {
    const bodies: string[] = [];
    const d = deps(async (w) => {
      bodies.push(String(w.body));
      return msg("Adds a helper for small tasks. It runs locally.");
    });
    cachedTldr(d.logDir!, "lg1", LONG_SPEC, d);
    await new Promise((r) => setTimeout(r, 30));
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("Add a helper for small tasks");
    expect(bodies[0]).toContain("Summarize this task spec");
  });

  it("cachedTldr stays null when the model fails", async () => {
    const d = deps(async () => {
      throw new Error("down");
    });
    cachedTldr(d.logDir!, "job2", LONG_SPEC, d);
    await new Promise((r) => setTimeout(r, 30));
    expect(cachedTldr(d.logDir!, "job2", LONG_SPEC, d)).toBeNull();
  });

  it("cleaners cut to the asked shape", () => {
    expect(cleanTldr("One is here for you. Two follows it. Three is extra.")).toBe("One is here for you. Two follows it.");
    expect(cleanGateSummary("1. a\n2. b\n3. c\n4. d")).toBe("a\nb\nc");
  });

  it("cleanTldr keeps a short answer with no final period (guardrail refusals and plain one-liners)", () => {
    expect(cleanTldr("Fixes the typo.")).toBe("Fixes the typo.");
    expect(cleanTldr("Renames snake_case_name to camelCase.")).toBe("Renames snake_case_name to camelCase.");
    expect(cleanTldr("Adds the chip. It lands in the status file")).toBe("Adds the chip. It lands in the status file");
    expect(cleanTldr("too short")).toBeNull();
    expect(cleanTldr("   ")).toBeNull();
  });

  it("trimTldrInput drops the worker-rules boilerplate and caps the rest at 1200 chars", () => {
    const spec = "Local worker rules:\n1. Type-check first.\n2. Read files whole.\n\nTrim the TL;DR input so the small model sees only the task.";
    expect(trimTldrInput(spec)).toBe("Trim the TL;DR input so the small model sees only the task.");
    const long = "x".repeat(5000);
    const cut = trimTldrInput(long);
    expect(cut.length).toBeLessThanOrEqual(1200 + "\n[...truncated...]".length);
    expect(cut).toContain("truncated");
    // boilerplate with no task after it: the whole text, capped — never an empty prompt
    expect(trimTldrInput("Local worker rules:\n1. only rules")).toBe("Local worker rules:\n1. only rules");
  });

  it("cachedTldr trims its input and retries once inside the call when the model answers empty", async () => {
    const inputs: string[] = [];
    let n = 0;
    // apple-fm answers empty (the real failure mode); the retry skips the cooling-down model and ollama answers
    const d = deps(async (w) => {
      inputs.push(String(w.body));
      n++;
      return w.kind === "messages" ? msg("") : ollama("Trims the spec input. Retries an empty answer.");
    });
    const spec = "Local worker rules:\n1. Type-check first.\n\nFix the TL;DR lane. " + LONG_SPEC;
    cachedTldr(d.logDir!, "job3", spec, d);
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(2); // one empty apple-fm answer, one retry — both inside this call
    for (const p of inputs) {
      expect(p).toContain("Fix the TL;DR lane.");
      expect(p).not.toContain("Type-check first"); // the boilerplate never reached the model
    }
    expect(existsSync(join(d.logDir!, "job3.tldr"))).toBe(true);
    const st = helperStats(d);
    expect(st.models["apple-fm"].fallbacks).toBe(1); // the empty answer, kind "empty"
    expect(st.models["ollama:qwen3:8b"].perHour).toBe(1);
  });

  it("cachedTldr still returns null when both attempts fail (helper down)", async () => {
    const d = deps(async () => {
      throw new Error("down");
    });
    cachedTldr(d.logDir!, "job4", LONG_SPEC, d);
    await new Promise((r) => setTimeout(r, 50));
    expect(cachedTldr(d.logDir!, "job4", LONG_SPEC, d)).toBeNull();
    // the retry skipped the cooling-down apple-fm and fell to ollama: one call per model, not two
    const by = callsOf(d);
    expect(by.filter((c) => c.model === "apple-fm").length).toBe(1);
    expect(by.filter((c) => c.model === "ollama:qwen3:8b").length).toBe(1);
    expect(by.every((c) => c.ok === false && c.kind === "error")).toBe(true);
  });

  it("config defaults", () => {
    expect(helperConfig({}).models).toEqual(["apple-fm", "@helper", "@legacy"]);
    expect(helperConfig({ uses: { tldr: false } }).uses.tldr).toBe(false);
  });
});

describe("helper topic word", () => {
  it("parseTopicWord takes the word out of a decorated one-word answer, rejects prose", () => {
    expect(parseTopicWord("strata")).toBe("strata");
    expect(parseTopicWord("Strata")).toBe("strata");
    expect(parseTopicWord(" Topic: queue.")).toBe("queue");
    expect(parseTopicWord('"tests"')).toBe("tests");
    expect(parseTopicWord("I think this is about the router")).toBeNull();
    expect(parseTopicWord("code graph")).toBeNull();
    expect(parseTopicWord("")).toBeNull();
  });

  it("the closed list covers the topics the status files already use", () => {
    for (const w of ["harness", "workers", "cockpit", "router", "strata", "memory", "tests"]) expect(TOPIC_WORDS).toContain(w);
  });

  it("helperPickTopic picks a word from the list and caches it per worker", async () => {
    let asked = "";
    const d = deps(async (w) => ((asked = w.body), msg("strata")));
    expect(await helperPickTopic(d.logDir!, "w1", "research: Strata disk cache", "park conversations on SSD", d)).toBe("strata");
    expect(asked).toContain("harness"); // the closed list rode along in the prompt
    expect(readFileSync(join(d.logDir!, "w1.topic"), "utf8").trim()).toBe("strata");
    let asked2 = 0;
    const d2 = deps(async () => (asked2++, msg("router")));
    expect(await helperPickTopic(d.logDir!, "w1", "anything", "anything", d2)).toBe("strata");
    expect(asked2).toBe(0); // cached: the model is never asked again
  });

  it("helperPickTopic accepts a new single lowercase word the list lacks", async () => {
    const d = deps(async () => msg("telemetry"));
    expect(await helperPickTopic(d.logDir!, "w2", "instrument the router", "spec", d)).toBe("telemetry");
  });

  it("junk answers and a down helper give no topic", async () => {
    const junk = deps(async () => msg("I think this job is about general matters"));
    expect(await helperPickTopic(junk.logDir!, "w3", "l", "s", junk)).toBeNull();
    resetHelperState();
    const down = deps(async () => {
      throw new Error("down");
    });
    expect(await helperPickTopic(down.logDir!, "w4", "l", "s", down)).toBeNull();
    expect(existsSync(join(down.logDir!, "w4.topic"))).toBe(false);
  });

  it("pickTopicAsync lands the word on the status file; a worker's own next save keeps it; helper down = no topic, no throw", async () => {
    const d = deps(async () => msg("mailbox"));
    saveStatus(d.logDir!, workerStatus("w5"));
    pickTopicAsync(d.logDir!, "w5", "digest noise", "spec text", d);
    await new Promise((r) => setTimeout(r, 30));
    expect(loadStatus(d.logDir!, "w5")?.topic).toBe("mailbox");
    // the runner's periodic save passes its in-memory copy (no topic): the pick survives it
    saveStatus(d.logDir!, workerStatus("w5"));
    expect(loadStatus(d.logDir!, "w5")?.topic).toBe("mailbox");
    resetHelperState();
    const down = deps(async () => {
      throw new Error("down");
    });
    saveStatus(down.logDir!, workerStatus("w6"));
    pickTopicAsync(down.logDir!, "w6", "l", "s", down);
    await new Promise((r) => setTimeout(r, 30));
    expect(loadStatus(down.logDir!, "w6")?.topic).toBeUndefined();
  });

  it("an explicit --topic always wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-"));
    expect(resolveTopic(dir, "harness", [], null)).toBe("harness");
    writeFileSync(join(dir, "keep"), "");
  });
});

describe("apple-fm summaries stop failing", () => {
  it("cleanTldr drops a chatty preface and markdown", () => {
    expect(cleanTldr("Sure! Here is the summary: **Adds the chip.** It lands in the status file.")).toBe("Adds the chip. It lands in the status file.");
    expect(cleanTldr("Here's the TL;DR:\n- Adds the chip to the cockpit status line.")).toBe("Adds the chip to the cockpit status line.");
  });

  it("an answer that cleans to nothing is asked once more, and the second answer is kept", async () => {
    const answers = ["ok", "Adds the chip. It lands in the status file."];
    const d = deps(async () => msg(answers.shift() ?? ""));
    cachedTldr(d.logDir!, "retry1", LONG_SPEC, d);
    await new Promise((r) => setTimeout(r, 50));
    expect(cachedTldr(d.logDir!, "retry1", LONG_SPEC, d)).toBe("Adds the chip. It lands in the status file.");
    expect(callsOf(d).map((c) => c.kind ?? "ok")).toEqual(["ok", "rejected", "ok"]);
  });

  it("apple-fm gets 60% of the budget, not an even share (answers at p90 5.9 s were cut at 5 s)", async () => {
    const seen: number[] = [];
    const d = deps(async (_w, t) => {
      seen.push(t);
      return msg("A summary of the task in words.");
    });
    await helperComplete({ task: "t", input: "i", timeoutMs: 12_000 }, d);
    expect(seen[0]).toBeGreaterThanOrEqual(7000);
  });
});

describe("apple-fm rejections and contention (#31)", () => {
  it("a guardrail refusal is a rejection with its reason and excerpt on the log line", async () => {
    const d = deps(async () => msg("May contain unsafe content"));
    cachedTldr(d.logDir!, "guard1", LONG_SPEC, d);
    await new Promise((r) => setTimeout(r, 50));
    const rej = callsOf(d).filter((c) => c.kind === "rejected");
    expect(rej.length).toBe(2);
    expect(rej[0]).toMatchObject({ reason: "guardrail", sample: "May contain unsafe content" });
  });

  it("a too-short answer logs why", async () => {
    const d = deps(async () => msg("ok."));
    cachedTldr(d.logDir!, "short1", LONG_SPEC, d);
    await new Promise((r) => setTimeout(r, 50));
    expect(callsOf(d).find((c) => c.kind === "rejected")).toMatchObject({ reason: "too-short", sample: "ok." });
  });

  it("a busy apple-fm is skipped at once (busy-fallback) and the next model answers", async () => {
    const urls: string[] = [];
    const d = deps(async (w) => {
      urls.push(w.kind);
      return JSON.stringify({ message: { content: "from ollama" } });
    }, { busy: (n) => n === "apple-fm" });
    expect(await helperComplete({ task: "t", input: "i", label: "tldr" }, d)).toBe("from ollama");
    expect(urls).toEqual(["ollama"]);
    expect(callsOf(d)[0]).toMatchObject({ model: "apple-fm", ok: false, kind: "busy-fallback", ms: 0 });
  });

  it("an idle apple-fm is asked as before", async () => {
    const d = deps(async () => msg("answer"), { busy: () => false });
    expect(await helperComplete({ task: "t", input: "i" }, d)).toBe("answer");
  });
});

describe("route classifier and report check on apple-fm", () => {
  const bounded = { label: "fix parser", text: "Fix the off-by-one in the tokenizer and add a test." };

  it("rules decide first: a cloud verdict never reaches the model", async () => {
    let calls = 0;
    const d = deps(async () => (calls++, msg("local: fine")));
    const r = await classifyRouteAssisted({ kind: "infra", text: "x" }, d);
    expect(r).toEqual({ where: "cloud", reason: "infra task" });
    expect(calls).toBe(0);
  });

  it("the model may move a default-local task to the cloud, same shape", async () => {
    const d = deps(async (w) => (w.kind === "messages" ? msg("cloud: touches several services") : ollama("local")));
    const r = await classifyRouteAssisted(bounded, d);
    expect(r).toEqual({ where: "cloud", reason: "model: touches several services" });
    expect(callsOf(d)[0]).toMatchObject({ label: "route", model: "apple-fm", ok: true });
  });

  it("local verdict, failure, garbage and a switched-off use all keep the rules' answer", async () => {
    const rules = { where: "local", reason: "bounded code task" };
    expect(await classifyRouteAssisted(bounded, deps(async () => msg("local: bounded")))).toEqual(rules);
    expect(await classifyRouteAssisted(bounded, deps(async () => { throw new Error("busy"); }))).toEqual(rules);
    resetHelperState();
    const g = deps(async () => msg("maybe, hard to say"));
    expect(await classifyRouteAssisted(bounded, g)).toEqual(rules);
    expect(callsOf(g).some((c) => c.kind === "rejected")).toBe(true);
    const off = deps(async () => msg("cloud: x"), { config: { ...DEFAULT_HELPER, uses: { ...DEFAULT_HELPER.uses, routeClass: false } } });
    expect(await classifyRouteAssisted(bounded, off)).toEqual(rules);
  });

  it("routeSecondOpinion is one call in flight", async () => {
    let open = 0;
    let max = 0;
    const d = deps(async () => {
      max = Math.max(max, ++open);
      await new Promise((r) => setTimeout(r, 10));
      open--;
      return msg("local");
    });
    await Promise.all([routeSecondOpinion("a task", d), routeSecondOpinion("b task", d), routeSecondOpinion("c task", d)]);
    expect(max).toBe(1);
  });

  it("proof verdicts parse; a switched-off check never objects", () => {
    expect(parseProofVerdict("nothing")).toBe(true);
    expect(parseProofVerdict("Proof.")).toBe(false);
    expect(parseProofVerdict("hm")).toBeNull();
    expect(proofIsEmpty("git diff HEAD", { config: { ...DEFAULT_HELPER, uses: { ...DEFAULT_HELPER.uses, reportCheck: false } } })).toBe(false);
    // no config under test: the helper is off, the check stays silent
    expect(proofIsEmpty("git diff HEAD")).toBe(false);
  });
});

describe("helper model resolution (small side-job model)", () => {
  const cfg = (o: Record<string, unknown> = {}) => helperConfig(o);
  const roles = (r: Record<string, "main" | "helper">): Partial<HelperDeps> => ({ providerRoles: () => r });

  it("default order: apple-fm, then role: helper providers; main models never", () => {
    const r = resolveHelperSpecs("route", cfg(), roles({ "apple-fm": "main", small: "helper", big: "main" }));
    expect(r.specs).toEqual(["apple-fm", "small"]); // qwen3:8b not installed here: no legacy entry
    expect(resolveHelperSpecs("route", cfg(), { ...roles({ small: "helper" }), ollamaInstalled: (t) => t === "qwen3:8b" }).specs).toEqual(["apple-fm", "small", "ollama:qwen3:8b"]);
  });

  it("apple-fm absent + role helper: the helper provider serves", async () => {
    const d = deps(async () => msg("ok"), { config: cfg(), ...roles({ small: "helper", big: "main" }), routerModel: (n) => (n === "small" ? "qwen-0.6b" : null) });
    expect(await helperComplete({ task: "t", input: "i", label: "route" }, d)).toBe("ok");
    expect(callsOf(d)[0].model).toBe("small");
  });

  it("apple-fm absent + none: skip (null), the main model is not asked", async () => {
    let asked = 0;
    const d = deps(async () => (asked++, msg("x")), { config: cfg(), ...roles({ big: "main" }), routerModel: (n) => (n === "big" ? "big-model" : null) });
    expect(await helperComplete({ task: "t", input: "i", label: "tldr" }, d)).toBeNull();
    expect(asked).toBe(0);
  });

  it("a main provider named in models is refused unless allowMain", () => {
    const o = { models: ["big"] };
    expect(resolveHelperSpecs("tldr", cfg(o), roles({ big: "main" }))).toEqual({ specs: [], refused: ["big"] });
    expect(resolveHelperSpecs("tldr", cfg({ ...o, allowMain: true }), roles({ big: "main" })).specs).toEqual(["big"]);
  });

  it("per-use override wins over helper.models", () => {
    const c = cfg({ models: ["apple-fm"], uses: { tldr: { models: ["ollama:qwen3:1.7b"] }, routeClass: false } });
    expect(resolveHelperSpecs("tldr", c, roles({})).specs).toEqual(["ollama:qwen3:1.7b"]);
    expect(resolveHelperSpecs("route", c, roles({})).specs).toEqual(["apple-fm"]);
    expect(c.uses.routeClass).toBe(false);
  });

  it("a busy or down helper is skipped at once and the next one answers", async () => {
    const c = cfg({ models: ["apple-fm", "small", "ollama:tiny"] });
    const d = deps(async () => msg("small"), { config: c, ...roles({ small: "helper" }), routerModel: (n) => n, busy: (n) => n === "apple-fm" });
    expect(await helperComplete({ task: "t", input: "i", label: "gate" }, d)).toBe("small");
    expect(callsOf(d).map((x) => [x.model, x.kind ?? "ok"])).toEqual([["apple-fm", "busy-fallback"], ["small", "ok"]]);
    resetHelperState();
    const d2 = deps(async (w) => { if (w.kind === "messages") throw new Error("down"); return ollama("tiny"); }, { config: c, ...roles({ small: "helper" }), routerModel: (n) => n });
    expect(await helperComplete({ task: "t", input: "i", label: "gate" }, d2)).toBe("tiny");
  });
});

describe("helper report and setup warning", () => {
  const roles = (r: Record<string, "main" | "helper">): Partial<HelperDeps> => ({ providerRoles: () => r });
  it("warns with no apple-fm and no role: helper; silent with either", () => {
    expect(helperSetupWarning(helperConfig({}), roles({ big: "main" }))).toMatch(/no helper model/);
    expect(helperSetupWarning(helperConfig({}), roles({ small: "helper" }))).toBeNull();
    expect(helperSetupWarning(helperConfig({}), roles({ "apple-fm": "main" }))).toBeNull();
  });
  it("report names the model per use", () => {
    const r = helperReport(helperConfig({ uses: { tldr: { models: ["ollama:q"] } } }), roles({ small: "helper" })).join("\n");
    expect(r).toMatch(/tldr\s+ollama:q/);
    expect(r).toMatch(/route\s+small/);
  });
});

describe("legacy ollama:qwen3:8b default", () => {
  it("no helper config, qwen3:8b installed: a failed apple-fm falls back to it", async () => {
    const d = deps(async (w) => { if (w.kind === "messages") throw new Error("aborted"); return ollama("legacy ok"); }, {
      config: helperConfig({}), providerRoles: () => ({ "apple-fm": "main" }), ollamaInstalled: (t) => t === "qwen3:8b",
    });
    expect(await helperComplete({ task: "t", input: "i", label: "tldr" }, d)).toBe("legacy ok");
    expect(callsOf(d).map((x) => [x.model, x.ok])).toEqual([["apple-fm", false], ["ollama:qwen3:8b", true]]);
  });
  it("not installed: skipped, and the setup warning stays", () => {
    const d: Partial<HelperDeps> = { providerRoles: () => ({}), ollamaInstalled: () => false };
    expect(configuredHelperSpecs("tldr", helperConfig({}), d)).toEqual([]);
    expect(helperSetupWarning(helperConfig({}), d)).toMatch(/no helper model/);
  });
});
