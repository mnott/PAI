import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisionTick, supervisionEventsPath } from "./supervision.js";
import { recordToolError, clipRaw } from "./tool-errors.js";
import { GUARD_MARKER } from "../hooks/ts/lib/render-decision.js";
import type { WorkerStatus } from "./status.js";
import { classifyToolError, summarizeToolInput, toolErrorText, detectRunningWorkerErrors, detectToolErrors, groupToolErrors, normalizeError, pushable, RESEND_MS, toolErrorSigTag, type ToolErrorRecord, isBenignBash, harnessToolErrorTexts } from "./tool-errors.js";
import { detectTrigger } from "./escalation.js";

const rec = (worker: string, ts: number, raw: string, tool = "Read", provider = "p"): ToolErrorRecord => ({
  ts, worker, provider, label: "l", tool, raw, signature: normalizeError(tool, raw),
});
const NOW = 10_000_000_000;

describe("normalizeError", () => {
  it("masks paths", () => {
    expect(normalizeError("Read", "File does not exist. Note: your current working directory is /a/b/c")).toBe(
      "Read|File does not exist. Note: your current working directory is <P>"
    );
    expect(normalizeError("Read", "File does not exist. Note: your current working directory is /x/y")).toBe(
      normalizeError("Read", "File does not exist. Note: your current working directory is /a/b/c")
    );
  });
  it("keeps the fixed Edit text", () => {
    expect(normalizeError("Edit", "No changes to make: old_string and new_string are exactly the same")).toBe(
      "Edit|No changes to make: old_string and new_string are exactly the same"
    );
  });
  it("masks quotes, numbers, ids", () => {
    expect(normalizeError("Bash", "worker 20261015-221657-31618 failed 500 on 'abc'")).toBe("Bash|worker <ID> failed <N> on <S>");
  });
  it("hook error", () => {
    const n = normalizeError("Read", "PreToolUse:Read hook error: Your working directory is /w/x. Paths outside it");
    expect(n).toBe("Read|PreToolUse:Read hook error: Your working directory is <P> Paths outside it".replace("<P> Paths", "<P> Paths"));
  });
});

describe("detectToolErrors", () => {
  const t = "File does not exist.";
  it("a: three in one worker", () => {
    const r = [rec("w1", NOW - 3, t), rec("w1", NOW - 2, t), rec("w1", NOW - 1, t)];
    expect(detectToolErrors(r, NOW, {})).toHaveLength(1);
    expect(detectToolErrors(r.slice(0, 2), NOW, {})).toHaveLength(0);
  });
  it("b: two workers within 30 min, not outside", () => {
    expect(detectToolErrors([rec("w1", NOW - 1000, t), rec("w2", NOW - 500, t)], NOW, {})).toHaveLength(1);
    expect(detectToolErrors([rec("w1", NOW - 31 * 60_000, t), rec("w2", NOW - 500, t)], NOW, {})).toHaveLength(0);
  });
  it("c: hook error needs 2 in one worker or 1 each in 2 workers", () => {
    const h = "PreToolUse:Read hook error: nope";
    expect(detectToolErrors([rec("w1", NOW - 1, h)], NOW, {})).toHaveLength(0);
    expect(detectToolErrors([rec("w1", NOW - 2, h), rec("w1", NOW - 1, h)], NOW, {})).toHaveLength(1);
    expect(detectToolErrors([rec("w1", NOW - 2, h), rec("w2", NOW - 1, h)], NOW, {})).toHaveLength(1);
    expect(detectToolErrors([rec("w1", NOW - 2, "plain failure"), rec("w1", NOW - 1, "plain failure")], NOW, {})).toHaveLength(0);
  });
  it("dedupes within 30 min, re-sends after", () => {
    const r = [rec("w1", NOW - 3, t), rec("w1", NOW - 2, t), rec("w1", NOW - 1, t)];
    const sent: Record<string, number> = {};
    expect(detectToolErrors(r, NOW, sent)).toHaveLength(1);
    expect(detectToolErrors(r, NOW + 1000, sent)).toHaveLength(0);
    const fresh = [rec("w1", NOW + RESEND_MS, t), rec("w1", NOW + RESEND_MS + 1, t), rec("w1", NOW + RESEND_MS + 2, t)];
    expect(detectToolErrors([...r, ...fresh], NOW + RESEND_MS + 3, sent)).toHaveLength(1);
  });
  it("never re-alerts old records after the dedupe expires", () => {
    const r = [rec("w1", NOW - 3, t), rec("w1", NOW - 2, t), rec("w1", NOW - 1, t)];
    const sent: Record<string, number> = {};
    expect(detectToolErrors(r, NOW, sent)).toHaveLength(1);
    expect(detectToolErrors(r, NOW + RESEND_MS + 1, sent)).toHaveLength(0);
  });
  it("groups", () => {
    const g = groupToolErrors([rec("w1", 1, t), rec("w2", 5, t)]);
    expect(g[0]).toMatchObject({ count: 2, first: 1, last: 5, lastWorker: "w2" });
  });
});

describe("supervision tick", () => {
  it("records, messages the owner once, and not again within 30 min", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-toolerr-"));
    try {
      const now = new Date();
      const st = {
        id: "20261016-000000-1", pid: 1, label: "l", cwd: "/", term: "", provider: "p", model: "m", state: "running",
        started: "2026-10-16 00:00:00", updated: "2026-10-16 00:00:00", turns: 1, tools: 1, last: "", rc: null, secs: null,
        spawnerSession: "sess-1",
      } as unknown as WorkerStatus;
      for (let i = 0; i < 3; i++) {
        recordToolError(dir, { worker: st.id, provider: "p", label: "l", tool: "Read", text: `File does not exist. Note: your current working directory is /t/${i}` }, now.getTime());
      }
      const pushed: string[] = [];
      const push = async (_d: string, _t: unknown, ev: { text: string }) => (pushed.push(ev.text), true);
      const opts = { now, isAlive: () => true, statuses: [st], stallMs: 1e12, push, pushPolicy: "all" as const };
      const r1 = await runSupervisionTick(dir, opts);
      expect(r1.events.filter((e) => e.kind === "toolerror")).toHaveLength(1);
      expect(pushed[0]).toMatch(/^\[unknown\] Read\|File does not exist.*<P> ×3 in 20261016-000000-1 — sample: /);
      expect(readFileSync(supervisionEventsPath(dir, "sess-1"), "utf8")).toContain("toolerror");
      const r2 = await runSupervisionTick(dir, opts);
      expect(r2.events.filter((e) => e.kind === "toolerror")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tool input", () => {
  it("summarizes path, pattern, command", () => {
    expect(summarizeToolInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput({ path: "/src", pattern: "foo" })).toBe("/src foo");
    expect(summarizeToolInput({ command: "x".repeat(1500) })).toHaveLength(1000);
    expect(summarizeToolInput(null)).toBeUndefined();
  });
  it("alert shows input and rule b counts only recent workers", () => {
    const old = rec("old", NOW - 33 * 60_000, "File does not exist");
    const a = { ...rec("w1", NOW - 2000, "File does not exist"), input: "/x/y.ts" };
    const b = rec("w2", NOW - 1000, "File does not exist");
    const [g] = detectToolErrors([old, a, b], NOW, {});
    expect(g.workers).toEqual(["w1", "w2"]);
    expect(toolErrorText(groupToolErrors([a])[0])).toContain("(input: /x/y.ts)");
  });
});

describe("classification", () => {
  const inp = (r: ToolErrorRecord, input: string): ToolErrorRecord => ({ ...r, input });
  const three = (raw: string, tool = "Bash") => [rec("w1", NOW - 3, raw, tool), rec("w1", NOW - 2, raw, tool), rec("w1", NOW - 1, raw, tool)];

  it("grep no matches is model-only and never alerts", () => {
    const r = three("zsh: no matches found: foo", "Grep");
    expect(classifyToolError(r[0]).cls).toBe("model");
    expect(detectToolErrors([...r, rec("w2", NOW - 1, "zsh: no matches found: foo", "Grep")], NOW, {})).toHaveLength(0);
  });
  it("Read missing inside cwd is silent; outside cwd is unknown", () => {
    const raw = "File does not exist. Note: your current working directory is /w/x";
    const inside = inp(rec("w1", NOW - 1, raw), "/w/x/a.ts");
    expect(classifyToolError(inside).cls).toBe("model");
    expect(detectToolErrors([inside, { ...inside, worker: "w2" }], NOW, {})).toHaveLength(0);
    expect(classifyToolError(inp(rec("w1", NOW - 1, raw), "/other/a.ts")).cls).toBe("unknown");
  });
  it("Edit mismatches alert only at 5 in one worker", () => {
    const raw = "String to replace not found in file";
    const r = [1, 2, 3, 4, 5].map((i) => rec("w1", NOW - i, raw, "Edit"));
    expect(detectToolErrors(r.slice(0, 4), NOW, {})).toHaveLength(0);
    const [g] = detectToolErrors(r, NOW, {});
    expect(toolErrorText(g)).toMatch(/^\[model ×5\] .*counts against the model; stop the run if it loops/);
  });
  it("guard denials alert only at 3 in one worker", () => {
    for (const raw of ["denied: no AI attribution in commits", "git checkout main blocked by hook", "sleep 90 blocked", "Bash timeout 500000 blocked"]) {
      const r = three(raw);
      expect(classifyToolError(r[0]).cls).toBe("model");
      expect(detectToolErrors(r.slice(0, 2), NOW, {})).toHaveLength(0);
      expect(detectToolErrors(r, NOW, {})).toHaveLength(1);
    }
  });
  it("PAI guard redirects are benign", () => {
    const raws = [
      "PreToolUse:Bash hook error: " + GUARD_MARKER + "node cannot load TypeScript source",
      "PreToolUse:Bash hook error: " + GUARD_MARKER + "orchestrator mode: Bash may not write code files",
      "PreToolUse:Bash hook error: " + GUARD_MARKER + "pattern-based process kill blocked",
      "PreToolUse:Bash hook error: " + GUARD_MARKER + "tsc with a file argument ignores tsconfig.json; run npx tsc --noEmit",
      "PreToolUse:Edit hook error: " + GUARD_MARKER + "Wrong path. Use exactly: /w/src/a.ts",
      "PreToolUse:Agent hook error: " + GUARD_MARKER + "Anthropic subagents are denied; use pai worker run",
      "PreToolUse:mcp__x__y hook error: " + GUARD_MARKER + "stale deferred-tool schema; call ToolSearch first",
      "PreToolUse:R hook error: " + GUARD_MARKER + "write your R report as plain text in your final answer, not as a tool call"
    ];
    for (const raw of raws) {
      const r = rec("w1", NOW, raw);
      expect(classifyToolError(r).cls).toBe("benign");
      expect(classifyToolError(r).hint).toMatch(/guard redirect/);
    }
  });
  it("Notes/ force-add denial is a guard redirect, not a harness error", () => {
    const raw = "PreToolUse:Bash hook error: " + GUARD_MARKER + "Notes/ and other ignored paths stay untracked; copy notes to /tmp/pai-notes/ instead (merge salvages Notes/ automatically)";
    const r = inp(rec("w1", NOW, raw, "Bash"), "git add -f Notes/three-tier-log.md && git commit -qm x");
    expect(classifyToolError(r).cls).toBe("benign");
    expect(classifyToolError(r).hint).toMatch(/guard redirect/);
  });
  it("sleep-poll denial with the marker stays a model error", () => {
    const r = rec("w1", NOW, "PreToolUse:Bash hook error: " + GUARD_MARKER + "sleep 90 blocked: use pai worker wait", "Bash");
    expect(classifyToolError(r).cls).toBe("model");
  });
  it("a guard-like text without the marker is not benign", () => {
    const r = rec("w1", NOW, "PreToolUse:Bash hook error: tsc with a file argument ignores tsconfig.json; run npx tsc --noEmit", "Bash");
    expect(classifyToolError(r).cls).not.toBe("benign");
  });
  it("No such tool: not in grant -> model, in grant -> harness, no grant -> harness", () => {
    const raw = "No such tool available: Write. Write is disabled for this session";
    const withGrant = (granted?: string[]) => ({ ...rec("w1", NOW, raw, "Write"), granted });
    expect(classifyToolError(withGrant(["Read", "Grep", "Bash"]))).toMatchObject({ cls: "model", hint: "used a tool it was not granted" });
    expect(classifyToolError(withGrant(["Read", "Write"])).cls).toBe("harness");
    expect(classifyToolError(withGrant()).cls).toBe("harness");
    expect(classifyToolError(withGrant([])).cls).toBe("harness");
  });
  it("a withheld Write never escalates; a granted Write reported missing does", () => {
    const raw = "No such tool available: Write. Write is disabled for this session";
    const withGrant = (granted: string[]) => [{ ...rec("w1", NOW, raw, "Write"), granted }];
    const trigger = (granted: string[]) => detectTrigger({ toolErrors: harnessToolErrorTexts(withGrant(granted)), reportValid: true });
    expect(trigger(["Read", "Bash", "Grep", "Glob"])).toBeNull();
    expect(trigger(["Read", "Write"])).toMatchObject({ kind: "missing-tool" });
  });
  it("harness errors alert at the usual thresholds", () => {
    for (const raw of ["Working directory /a/b was deleted", "API Error: 401 Failed to authenticate", "No such tool available: Foo", "fetch http://localhost:9 returned 503"]) {
      expect(classifyToolError(rec("w1", NOW, raw)).cls).toBe("harness");
    }
    const [g] = detectToolErrors(three("API Error: 500 oops"), NOW, {});
    expect(toolErrorText(g)).toMatch(/^\[harness\] .*— fix at the owner\. harness → stop runs it spoils/);
  });
  it("a bare 401/429/500 in ordinary tool output is not harness", () => {
    const sample = "Exit code 1 verify 401 / 1223 verify 451 / 1223 ls: /tmp/strata-x: No such file or directory";
    expect(classifyToolError(rec("w1", NOW, sample, "Bash")).cls).toBe("model");
    for (const raw of ["progress 401 of 1223", "processed 429 files", "wrote 500 lines to localhost:8080 log"]) {
      expect(classifyToolError(rec("w1", NOW, raw, "Bash")).cls).not.toBe("harness");
    }
  });
  it("real API/auth evidence stays harness", () => {
    for (const raw of ["401 Unauthorized", "API Error: 429 rate_limit_error", "overloaded_error: Overloaded", "invalid x-api-key", "OAuth token has expired", "request failed with status 401", "authentication_error"]) {
      expect(classifyToolError(rec("w1", NOW, raw, "Bash")).cls).toBe("harness");
    }
  });
  it("hook error on an existing path outside cwd is harness", () => {
    const raw = "PreToolUse:Read hook error: Your working directory is /w/x. Path /tmp is outside";
    expect(classifyToolError(rec("w1", NOW, raw)).cls).toBe("harness");
    expect(classifyToolError(rec("w1", NOW, "PreToolUse:Read hook error: Your working directory is /w/x. Path /nonexistent/zz is outside")).cls).toBe("unknown");
  });
  it("ls sleep poll is benign", () => {
    const r = inp(rec("w1", NOW, "Exit code 1 ls: /tmp/x.rc: No such file or directory", "Bash"), "sleep 20; ls /tmp/x.rc");
    expect(isBenignBash(r)).toBe(true);
    const r2 = inp(rec("w1", NOW, "Exit code 1 ls: /tmp/x.rc: No such file or directory", "Bash"), "ls /tmp/x.rc");
    expect(isBenignBash(r2)).toBe(false);
  });
  it("permission refusal is a model error", () => {
    const raw = "Permission to use Bash with command rm -rf /tmp/jc-w && npx -y jscpd@4 src has been denied.";
    const c = classifyToolError(rec("w1", NOW, raw, "Bash"));
    expect(c.cls).toBe("model");
    expect(c.loopAt).toBe(3);
    expect(c.hint).toBe("command refused by the permission layer");
  });
  it("compound whose last stage is a read-only probe exiting 1 is benign", () => {
    const input = "sed -i 's/a/b/' src/x.ts ; npx tsc --noEmit | tail -3; git diff src | grep '^[+-]' | head -50; ls src/cli/lib/*find* src/cli/lib/*gate* 2>/dev/null";
    const r = inp(rec("w1", NOW, "Exit code 1\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b", "Bash"), input);
    expect(isBenignBash(r)).toBe(true);
    expect(classifyToolError(r).cls).toBe("benign");
  });
  it("exit 1 with clean output is benign, with failure evidence is not", () => {
    const loop = 'for f in a.ts b.ts; do for n in x y z; do c=$(grep -c "\\b$n\\b" $f); [ "$c" -le 1 ] && echo $f $n $c; done; done';
    expect(isBenignBash(inp(rec("w1", NOW, "Exit code 1\nsrc/memory/indexer/async.ts sha256File 1", "Bash"), loop))).toBe(true);
    expect(isBenignBash(inp(rec("w1", NOW, "Exit code 1\nerror TS2304: Cannot find name", "Bash"), "npm run build"))).toBe(false);
    expect(isBenignBash(inp(rec("w1", NOW, "Exit code 1\nFAIL src/x.test.ts", "Bash"), "npm run check"))).toBe(false);
    const ls = inp(rec("w1", NOW, "Exit code 1\nls: x: No such file or directory", "Bash"), "ls x");
    expect(isBenignBash(ls)).toBe(false);
    expect(classifyToolError(ls).cls).toBe("model");
  });
  it("a failing build stays unknown", () => {
    const r = inp(rec("w1", NOW, "Exit code 1\nsrc/x.ts(1,1): error TS2304: Cannot find name 'q'", "Bash"), "npm run build");
    expect(isBenignBash(r)).toBe(false);
    expect(classifyToolError(r).cls).toBe("unknown");
  });
  it("heredoc bodies do not affect last command", () => {
    const input = ["cat > /tmp/x.txt <<'EOF'", "it's; a b", "other line; it's", "EOF", "pai worker wait-file /tmp/x.rc --max 90"].join("\n");
    const r = inp(rec("w1", NOW, "Exit code 3 missing: /tmp/x.rc not yet: 1 of 1 missing after 90s; call wait-file again", "Bash"), input);
    expect(isBenignBash(r)).toBe(true);
  });
  it("groupToolErrors still counts guard redirects", () => {
    const raw = "PreToolUse:Bash hook error: " + GUARD_MARKER + "node cannot load TypeScript source";
    const r = rec("w1", NOW, raw);
    const groups = groupToolErrors([r]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1);
  });
  it("everything else is unknown", () => {
    const [g] = detectToolErrors(three("weird failure"), NOW, {});
    expect(toolErrorText(g)).toMatch(/^\[unknown\] /);
  });
});

describe("clipRaw", () => {
  it("returns short texts unchanged", () => {
    const short = "abc";
    expect(clipRaw(short)).toBe(short);
  });
  it("truncates long texts keeping head and tail", () => {
    const long = "x".repeat(400) + " ls: /tmp/x.rc: No such file or directory";
    const result = clipRaw(long);
    expect(result).toHaveLength(300);
    expect(result.startsWith("xxx")).toBe(true);
    expect(result.endsWith("No such file or directory")).toBe(true);
  });
});

describe("detectRunningWorkerErrors", () => {
  const running = [{ id: "w1", session: "sess-1" }, { id: "w2", session: "sess-2" }];
  const inp = (r: ToolErrorRecord, input: string): ToolErrorRecord => ({ ...r, input });
  it("first occurrence of each signature per run, all classes", () => {
    const doomed = [
      // [model]-class, loopAt Infinity — exactly what the old filter hid
      inp(rec("w1", NOW - 3, "File does not exist. Note: your current working directory is /w/x"), "/w/x/a.ts"),
      // [harness]
      rec("w1", NOW - 2, "API Error: 401 Failed to authenticate"),
      // [unknown]
      rec("w1", NOW - 1, "weird failure"),
      // same [model] signature again: counted, not a second push
      inp(rec("w1", NOW - 1, "File does not exist. Note: your current working directory is /w/x"), "/w/x/a.ts"),
    ];
    const sent: Record<string, Record<string, number>> = {};
    const pushes = detectRunningWorkerErrors(running, doomed, sent, NOW);
    expect(pushes).toHaveLength(3);
    const classes = pushes.map((p) => p.group.cls).sort().join(",");
    expect(classes).toBe("harness,model,unknown");
    expect(pushes.every((p) => p.worker === "w1" && p.session === "sess-1")).toBe(true);
    const model = pushes.find((p) => p.group.cls === "model")!;
    expect(model.group.count).toBe(2); // both occurrences counted in the group
    expect(toolErrorText(model.group)).toMatch(/^\[model ×2\]/);
    // state remembers all three signatures
    expect(Object.keys(sent.w1)).toHaveLength(3);
  });

  it("a pushed signature is never re-pushed in the same run", () => {
    const sent: Record<string, Record<string, number>> = { w1: {} };
    const sig = rec("w1", NOW - 1, "weird failure").signature;
    sent.w1[sig] = NOW - 30_000;
    const pushes = detectRunningWorkerErrors(
      running,
      [rec("w1", NOW - 1, "weird failure")],
      sent,
      NOW
    );
    expect(pushes).toHaveLength(0);
  });

  it("ignores workers that are not running (and unowned records stay legacy)", () => {
    const pushes = detectRunningWorkerErrors(
      [{ id: "w2", session: "sess-2" }],
      [rec("w1", NOW - 1, "weird failure")],
      {},
      NOW
    );
    expect(pushes).toHaveLength(0);
  });

  it("per-worker isolation: w2's push carries only w2's records", () => {
    const same = "weird failure";
    const pushes = detectRunningWorkerErrors(
      running,
      [rec("w1", NOW - 2, same), rec("w2", NOW - 1, same)],
      {},
      NOW
    );
    expect(pushes).toHaveLength(2);
    expect(pushes.map((p) => p.group.count).sort().join(",")).toBe("1,1");
  });

  it("toolErrorSigTag is stable and input-sensitive", () => {
    expect(toolErrorSigTag("Read|abc")).toBe(toolErrorSigTag("Read|abc"));
    expect(toolErrorSigTag("Read|abc")).not.toBe(toolErrorSigTag("Bash|abc"));
  });
});

describe("classifyToolError wait poll", () => {
  const w = (raw: string, input: string) => classifyToolError({ ts: 0, worker: "w", provider: "p", label: "", tool: "Bash", signature: "", raw, input });
  it("multi-line wait --max exit 3 is benign", () => {
    expect(w('Exit code 3\n{"id":"x","state":"running"}\npai worker wait: still running: x', "pai worker wait --max 100 x").cls).toBe("benign");
  });
  it("wait exit 1 and other exit 3 are not benign", () => {
    expect(w("Exit code 1\npai worker wait: failed: x", "pai worker wait x").cls).not.toBe("benign");
    expect(w("Exit code 3\nboom", "make build").cls).not.toBe("benign");
  });
});
