import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { callerItermId, supervisionBanner } from "./supervision-banner.js";
import type { HostDeps } from "../../../workers/pane.js";
import { resolveHostSession } from "../../../workers/pane.js";

const UID = "88D76B26-0000-0000-0000-000000000001";
const NOW = new Date(2026, 9, 20, 1, 0).getTime();
const UNTIL = new Date(2026, 9, 20, 8, 0).getTime();

function file(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "sup-")), "managers.json");
  writeFileSync(p, content);
  return p;
}
const entry = (o: object) =>
  JSON.stringify({ [UID]: { sessionId: UID, objective: "Work the night shift", shift: { until: UNTIL }, ...o } });

describe("supervisionBanner", () => {
  it("live entry injects until time, arm-self and objective head", () => {
    const t = supervisionBanner(UID, file(entry({})), NOW)!;
    expect(t).toContain("SUPERVISION ACTIVE until 08:00");
    expect(t).toContain("aibroker arm-self");
    expect(t).toContain("Objective: Work the night shift");
    expect(t).toContain("NEVER ask the operator to type /goal");
  });
  it("objective is cut to 120 chars", () => {
    const t = supervisionBanner(UID, file(entry({ objective: "x".repeat(300) })), NOW)!;
    expect(t).toContain(`Objective: ${"x".repeat(120)}.`);
  });
  it("paused, expired, no shift, other session: silent", () => {
    expect(supervisionBanner(UID, file(entry({ paused: true })), NOW)).toBeNull();
    expect(supervisionBanner(UID, file(entry({ shift: { until: NOW - 1 } })), NOW)).toBeNull();
    expect(supervisionBanner(UID, file(entry({ shift: undefined })), NOW)).toBeNull();
    expect(supervisionBanner("OTHER", file(entry({})), NOW)).toBeNull();
    expect(supervisionBanner("", file(entry({})), NOW)).toBeNull();
  });
  it("absent or malformed file: silent, no throw", () => {
    expect(supervisionBanner(UID, join(tmpdir(), "nope-managers.json"), NOW)).toBeNull();
    expect(supervisionBanner(UID, file("{not json"), NOW)).toBeNull();
    expect(supervisionBanner(UID, file("null"), NOW)).toBeNull();
  });
});

describe("callerItermId", () => {
  it("uses ITERM_SESSION_ID when set", async () => {
    expect(await callerItermId({ ITERM_SESSION_ID: `w1t0p0:${UID}` }, async () => ({ uid: "no" }))).toBe(UID);
  });
  it("under the background daemon, resolves via the attach client in an injected process table", async () => {
    const procs: Record<number, [number, string]> = { 500: [400, "??"], 400: [1, "??"] };
    const deps: HostDeps = {
      psOf: (pid) => procs[pid] ?? null,
      commandsOf: (pids) => new Map(pids.map((p) => [p, p === 400 ? "claude --bg-pty-host abcd1234-aaaa" : "node"] as [number, string])),
      listSessions: async () => [{ id: UID, tty: "/dev/ttys009" }],
      attachClients: () => [900],
      itermIdOf: (pid) => (pid === 900 ? `w1t0p0:${UID}` : ""),
    };
    const id = await callerItermId({ CLAUDE_CODE_SESSION_ID: "abcd1234-aaaa-bbbb" }, () => resolveHostSession({ CLAUDE_CODE_SESSION_ID: "abcd1234-aaaa-bbbb" }, deps, 500));
    expect(id).toBe(UID);
  });
  it("unresolvable: empty, no throw", async () => {
    expect(await callerItermId({}, async () => { throw new Error("x"); })).toBe("");
  });
});

describe("hook registration", () => {
  it("runs on both the startup and compact matchers", async () => {
    const { readFileSync } = await import("fs");
    const hooks = JSON.parse(readFileSync("plugins/core/hooks/hooks.json", "utf8")).hooks.SessionStart as { matcher?: string; hooks: { command: string }[] }[];
    const g = hooks.find((h) => h.hooks.some((c) => c.command.includes("supervision-banner")));
    expect(g?.matcher?.split("|").sort()).toEqual(["compact", "startup"]);
  });
});
