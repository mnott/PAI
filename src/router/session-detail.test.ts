/**
 * session-detail.test.ts — the per-session drill-down: transcript parsing on a
 * synthetic transcript, and the GET /api/session/<id>/detail endpoint.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessions, sessionDetail, sessionTurnView } from "./session-detail.js";
import { handleCockpit } from "./cockpit.js";
import { combinedSearch, type MemorySearchFn } from "./session-memory.js";
import { utimesSync } from "node:fs";
import { withCockpitToken } from "./cockpit-auth.js";
import { fakeAnthropic, fakeSlack } from "../utils/fake-secret.js";

// Fake token-shaped fixture assembled at runtime so no scanner flags a literal.
const FAKE_KEY = fakeAnthropic("abcdefghijklmnopqrstuvwxyz0123456789", "-api03");

const dir = mkdtempSync(join(tmpdir(), "pai-session-detail-"));
const projects = join(dir, "projects");
const ID = "abcd1234-0000-4000-8000-000000000001";
const savedCfg = process.env.CLAUDE_CONFIG_DIR;

const user = (text: string, ts: string) => ({ type: "user", timestamp: ts, cwd: "/work/proj", message: { content: text } });
const asst = (ts: string, blocks: unknown[], model = "claude-test-1") => ({ type: "assistant", timestamp: ts, message: { model, content: blocks } });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const result = (id: string, text: string, is_error = false) => ({ type: "user", timestamp: "2026-01-01T00:00:09Z", message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: text }] } });

const lines = [
  user(`first prompt with ${FAKE_KEY} inside`, "2026-01-01T00:00:01Z"),
  asst("2026-01-01T00:00:02Z", [
    use("t1", "Edit", { file_path: "/work/proj/a.ts", old_string: "x", new_string: "l1\nl2\nl3" }),
    use("t2", "Write", { file_path: "/work/proj/b.ts", content: "one\ntwo" }),
    use("t3", "Bash", { command: "ls" }),
    use("t4", "Skill", { skill: "End" }),
    use("t5", "mcp__srv__ping", {}),
    use("t6", "mcp__srv__ping", {}),
  ]),
  result("t5", "pong"),
  result("t6", "boom", true),
  result("t3", "PreToolUse:Bash hook error: [guard]: rm is not allowed here"),
  user("second prompt", "2026-01-01T00:01:00Z"),
  asst("2026-01-01T00:01:01Z", [
    use("t7", "MultiEdit", { file_path: "/work/proj/a.ts", edits: [{ new_string: "q" }, { new_string: "r\ns" }] }),
    use("t8", "Read", { file_path: "/work/proj/a.ts" }),
  ], "claude-test-2"),
  user("third prompt", "2026-01-01T00:02:00Z"),
  user(
    "<command-message>Sync</command-message> <command-name>/Sync</command-name> <command-args>PAI</command-args>",
    "2026-01-01T00:03:00Z"
  ),
  user("<command-message>Go</command-message> <command-name>/Go</command-name>", "2026-01-01T00:04:00Z"),
  user("<command-name>/Broken</command-name> <command-args>orphan</command-args>", "2026-01-01T00:05:00Z"),
  user(
    "plain ask <system-reminder>hidden note</system-reminder> tail <local-command-stdout>scrolled output</local-command-stdout>",
    "2026-01-01T00:06:00Z"
  ),
];

beforeAll(() => {
  mkdirSync(join(projects, "-work-proj"), { recursive: true });
  writeFileSync(join(projects, "-work-proj", `${ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterAll(() => {
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedCfg;
  rmSync(dir, { recursive: true, force: true });
});

describe("sessionDetail", () => {
  it("groups turns by user prompt with tools, edits and command counts", async () => {
    const d = (await sessionDetail(ID, { projectsDir: projects }))!;
    expect(d.cwd).toBe("/work/proj");
    expect(d.models).toEqual(["claude-test-1", "claude-test-2"]);
    expect(d.turnCount).toBe(7);
    expect(d.turns.map((t) => t.idx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(d.turns[0].commands).toBe(1);
    expect(d.turns[0].edits).toEqual(["/work/proj/a.ts", "/work/proj/b.ts"]);
    expect(d.turns[0].tools).toContainEqual({ name: "mcp__srv__ping", count: 2 });
    expect(d.turns[1].tools).toEqual([{ name: "MultiEdit", count: 1 }, { name: "Read", count: 1 }]);
    expect(d.turns[2].tools).toEqual([]);
  });

  it("sums files changed from Edit / Write / MultiEdit inputs", async () => {
    const d = (await sessionDetail(ID, { projectsDir: projects }))!;
    expect(d.filesChanged).toEqual([
      { path: "/work/proj/a.ts", edits: 2, approxLinesChanged: 3 + 1 + 2 },
      { path: "/work/proj/b.ts", edits: 1, approxLinesChanged: 2 },
    ]);
  });

  it("lists skills, MCP failures and the hook denial", async () => {
    const d = (await sessionDetail(ID, { projectsDir: projects }))!;
    expect(d.skills).toEqual([
      { name: "End", ts: "2026-01-01T00:00:02Z" },
      // well-formed command markup renders to "/Name" before skill detection,
      // so only markup that survives the cleanup still counts as a skill
      { name: "Broken", ts: "2026-01-01T00:05:00Z" },
    ]);
    expect(d.mcp).toEqual([{ server: "srv", calls: 2, failures: 1 }]);
    expect(d.denials).toHaveLength(1);
    expect(d.denials[0]).toMatchObject({ tool: "Bash", reason: "rm is not allowed here" });
  });

  it("masks secrets in prompts", async () => {
    const d = (await sessionDetail(ID, { projectsDir: projects }))!;
    expect(d.turns[0].prompt).not.toContain(FAKE_KEY.slice(0, 35));
    expect(d.turns[0].prompt).toBe("first prompt with [REDACTED] inside");
  });

  it("keeps only the last maxTurns turns but reports the total", async () => {
    const d = (await sessionDetail(ID, { projectsDir: projects, maxTurns: 2 }))!;
    expect(d.turnCount).toBe(7);
    expect(d.turns.map((t) => t.prompt)).toEqual([
      "<command-name>/Broken</command-name> <command-args>orphan</command-args>",
      "plain ask  tail",
    ]);
  });

  it("renders slash-command prompts as /Name args and strips reminder/stdout blocks", async () => {
    const d = (await sessionDetail(ID, { projectsDir: projects, maxTurns: 100 }))!;
    expect(d.turns[3].prompt).toBe("/Sync PAI");
    expect(d.turns[4].prompt).toBe("/Go");
    // malformed markup (no command-message before command-name) keeps the original text
    expect(d.turns[5].prompt).toBe("<command-name>/Broken</command-name> <command-args>orphan</command-args>");
    expect(d.turns[6].prompt).toBe("plain ask  tail");
  });

  it("returns null for an unknown id and for an id that is not safe", async () => {
    expect(await sessionDetail("ffffffff-0000-4000-8000-000000000000", { projectsDir: projects })).toBeNull();
    expect(await sessionDetail("../../etc/passwd", { projectsDir: projects })).toBeNull();
  });
});

describe("sessionTurnView", () => {
  const tdir = join(dir, "turns");
  const TID = "turn0000-0000-4000-8000-000000000001";
  const SECRET = fakeSlack("xb", "1234567890", "abcdefghijklmnopqrst");
  beforeAll(() => {
    mkdirSync(join(tdir, "-w"), { recursive: true });
    writeFileSync(
      join(tdir, "-w", `${TID}.jsonl`),
      [
        user("fix the parser", "2026-01-01T00:00:01Z"),
        asst("2026-01-01T00:00:02Z", [{ type: "text", text: "let me look" }, use("u1", "Read", { file_path: "/w/a.ts" })]),
        result("u1", "contents"),
        asst("2026-01-01T00:00:03Z", [use("u2", "Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y" })]),
        result("u2", "ok"),
        asst("2026-01-01T00:00:04Z", [{ type: "text", text: `done — the key was ${SECRET}` }]),
        user("next ask", "2026-01-01T00:01:00Z"),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n"
    );
  });

  it("reads one turn: prompt, steps (tool calls and intermediate text) and the final reply", async () => {
    const t = (await sessionTurnView(TID, 0, { projectsDir: tdir }))!;
    expect(t).toMatchObject({ id: TID, idx: 0, turnCount: 2, ts: "2026-01-01T00:00:01Z", prompt: "fix the parser", promptTruncated: false, replyTruncated: false });
    expect(t.steps).toEqual([
      { kind: "text", summary: "let me look" },
      { kind: "tool", name: "Read", summary: 'Read: {"file_path":"/w/a.ts"}' },
      { kind: "tool", name: "Edit", summary: 'Edit: {"file_path":"/w/a.ts","old_string":"x","new_string":"y"}' },
    ]);
    expect(t.reply).toBe(`done — the key was [REDACTED]`);
  });

  it("redacts a token-shaped string in the reply", async () => {
    const t = (await sessionTurnView(TID, 0, { projectsDir: tdir }))!;
    expect(t.reply).not.toContain(SECRET);
    expect(t.reply).toContain("[REDACTED]");
  });

  it("the last turn has no reply and no steps; idx out of range and an unknown id read null", async () => {
    const last = (await sessionTurnView(TID, 1, { projectsDir: tdir }))!;
    expect(last).toMatchObject({ idx: 1, turnCount: 2, prompt: "next ask", reply: "", steps: [] });
    expect(await sessionTurnView(TID, 2, { projectsDir: tdir })).toBeNull();
    expect(await sessionTurnView(TID, -1, { projectsDir: tdir })).toBeNull();
    expect(await sessionTurnView("ffffffff-0000-4000-8000-000000000000", 0, { projectsDir: tdir })).toBeNull();
  });

  it("caps prompt and reply at 20k chars with a truncated flag", async () => {
    const CID = "cap00000-0000-4000-8000-000000000001";
    writeFileSync(
      join(tdir, "-w", `${CID}.jsonl`),
      [user("x".repeat(25_000), "2026-01-01T00:00:01Z"), asst("2026-01-01T00:00:02Z", [{ type: "text", text: "y".repeat(25_000) }])]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n"
    );
    const t = (await sessionTurnView(CID, 0, { projectsDir: tdir }))!;
    expect(t.prompt).toHaveLength(20_000);
    expect(t.promptTruncated).toBe(true);
    expect(t.reply).toHaveLength(20_000);
    expect(t.replyTruncated).toBe(true);
  });
});

describe("GET /api/session/<id>/detail", () => {
  const ask = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      http.request({ port, host: "127.0.0.1", path, headers }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b }));
      }).end();
    });
  const noMem: MemorySearchFn = async () => [];
  const serve = async (token?: string, memorySearch: MemorySearchFn = noMem) => {
    const inner = (req: http.IncomingMessage, res: http.ServerResponse) =>
      handleCockpit(req, res, { get: async () => [] }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { memorySearch });
    const h = token ? withCockpitToken(token, inner) : inner;
    const s = http.createServer((req, res) => {
      if (!h(req, res)) {
        res.writeHead(418);
        res.end();
      }
    });
    const port = await new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
    return { s, port };
  };

  it("200 with the detail, 404 for an unknown id, 400 for a malformed id", async () => {
    const { s, port } = await serve();
    try {
      const ok = await ask(port, `/api/session/${ID}/detail`);
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ id: ID, turnCount: 7 });
      expect((await ask(port, "/api/session/ffffffff-0000-4000-8000-000000000000/detail")).status).toBe(404);
      expect((await ask(port, "/api/session/short/detail")).status).toBe(400);
      expect((await ask(port, "/api/session/..%2f..%2fetc%2fpasswd/detail")).status).toBe(400);
    } finally {
      s.close();
    }
  });

  it("needs the cockpit token like the other cockpit routes", async () => {
    const { s, port } = await serve("tok");
    try {
      expect((await ask(port, `/api/session/${ID}/detail`)).status).toBe(401);
      expect((await ask(port, `/api/session/${ID}/detail`, { authorization: "Bearer tok" })).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe("GET /api/session/<id>/turn/<idx>", () => {
  const ask = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      http.request({ port, host: "127.0.0.1", path, headers }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b }));
      }).end();
    });
  const serve = async (token?: string) => {
    const inner = (req: http.IncomingMessage, res: http.ServerResponse) => handleCockpit(req, res, { get: async () => [] });
    const h = token ? withCockpitToken(token, inner) : inner;
    const s = http.createServer((req, res) => {
      if (!h(req, res)) {
        res.writeHead(418);
        res.end();
      }
    });
    const port = await new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
    return { s, port };
  };

  it("200 with the turn, 404 for a turn out of range, 400 for a malformed id", async () => {
    const { s, port } = await serve();
    try {
      const ok = await ask(port, `/api/session/${ID}/turn/1`);
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ id: ID, idx: 1, turnCount: 7, prompt: "second prompt" });
      expect((await ask(port, `/api/session/${ID}/turn/99`)).status).toBe(404);
      expect((await ask(port, `/api/session/${ID}/turn/abc`)).status).toBe(404); // not a turn path: the cockpit answers it with its own 404
      expect((await ask(port, "/api/session/short/turn/0")).status).toBe(400);
    } finally {
      s.close();
    }
  });

  it("needs the cockpit token like the other cockpit routes", async () => {
    const { s, port } = await serve("tok");
    try {
      expect((await ask(port, `/api/session/${ID}/turn/0`)).status).toBe(401);
      expect((await ask(port, `/api/session/${ID}/turn/0`, { authorization: "Bearer tok" })).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe("searchSessions", () => {
  it("finds the first matching prompt with its turn index, masked and case-insensitive", async () => {
    const { hits } = await searchSessions("THIRD prompt", { projectsDir: projects });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: ID, cwd: "/work/proj", turn: 2, snippet: "third prompt" });
    const slash = (await searchSessions("Sync PAI", { projectsDir: projects })).hits;
    expect(slash[0]).toMatchObject({ turn: 3, snippet: "/Sync PAI" });
    const masked = (await searchSessions("first prompt with", { projectsDir: projects })).hits;
    expect(masked[0].snippet).not.toContain(FAKE_KEY.slice(0, 35));
    expect(masked[0].snippet).toContain("[REDACTED]");
  });

  it("matches text a plain needle cannot find in the raw line (escapes, quotes) too", async () => {
    const p3 = join(dir, "projects3", "-w");
    mkdirSync(p3, { recursive: true });
    writeFileSync(join(p3, "esc00000-0000-4000-8000-000000000001.jsonl"), JSON.stringify(user('say "hi" there\nnext line', "2026-01-01T00:00:01Z")) + "\n");
    expect((await searchSessions('"hi"', { projectsDir: join(dir, "projects3") })).hits).toHaveLength(1);
    expect((await searchSessions("hi\" there\nnext", { projectsDir: join(dir, "projects3") })).hits).toHaveLength(1);
  });

  it("ignores assistant and tool text, hidden reminder blocks, and empty queries", async () => {
    expect((await searchSessions("hidden note", { projectsDir: projects })).hits).toEqual([]);
    expect((await searchSessions("pong", { projectsDir: projects })).hits).toEqual([]);
    expect((await searchSessions("  ", { projectsDir: projects })).hits).toEqual([]);
  });

  it("caps the number of sessions", async () => {
    const p2 = join(dir, "projects2", "-w");
    mkdirSync(p2, { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(p2, `cap0000${i}-0000-4000-8000-000000000001.jsonl`), JSON.stringify(user("needle here", "2026-01-01T00:00:01Z")) + "\n");
    expect((await searchSessions("needle", { projectsDir: join(dir, "projects2"), limit: 3 })).hits).toHaveLength(3);
    expect((await searchSessions("needle", { projectsDir: join(dir, "projects2"), budgetMs: -1 })).partial).toBe(true);
  });
});

describe("GET /api/sessions/search", () => {
  const ask = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      http.request({ port, host: "127.0.0.1", path, headers }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: b }));
      }).end();
    });
  const noMem: MemorySearchFn = async () => [];
  const serve = async (token?: string, memorySearch: MemorySearchFn = noMem) => {
    const inner = (req: http.IncomingMessage, res: http.ServerResponse) =>
      handleCockpit(req, res, { get: async () => [] }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { memorySearch });
    const h = token ? withCockpitToken(token, inner) : inner;
    const s = http.createServer((req, res) => {
      if (!h(req, res)) {
        res.writeHead(418);
        res.end();
      }
    });
    const port = await new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
    return { s, port };
  };

  it("200 with hits, 400 for a short or missing q", async () => {
    const { s, port } = await serve();
    try {
      const ok = await ask(port, "/api/sessions/search?q=second%20prompt");
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ q: "second prompt", hits: [{ id: ID, turn: 1 }] });
      expect((await ask(port, "/api/sessions/search?q=a")).status).toBe(400);
      expect((await ask(port, "/api/sessions/search")).status).toBe(400);
    } finally {
      s.close();
    }
  });

  it("refuses a foreign Host or Origin and needs the cockpit token", async () => {
    const { s, port } = await serve("tok");
    try {
      expect((await ask(port, "/api/sessions/search?q=second")).status).toBe(401);
      const auth = { authorization: "Bearer tok" };
      expect((await ask(port, "/api/sessions/search?q=second", auth)).status).toBe(200);
      expect((await ask(port, "/api/sessions/search?q=second", { ...auth, host: "evil.example.com" })).status).toBe(403);
      expect((await ask(port, "/api/sessions/search?q=second", { ...auth, origin: "http://evil.example.com" })).status).toBe(403);
    } finally {
      s.close();
    }
  });
});

describe("combined search: recent transcripts first, memory after", () => {
  const OLD = "abcd1234-0000-4000-8000-0000000000aa";
  const cdir = join(dir, "combined");
  const proj = join(cdir, "p");
  beforeAll(() => {
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${ID}.jsonl`), JSON.stringify(user("zebra crossing now", "2026-01-01T00:00:01Z")) + "\n");
    writeFileSync(join(proj, `${OLD}.jsonl`), JSON.stringify(user("zebra crossing long ago", "2025-01-01T00:00:01Z")) + "\n");
    const old = new Date(Date.now() - 100 * 3600_000);
    utimesSync(join(proj, `${OLD}.jsonl`), old, old);
  });
  const mem: MemorySearchFn = async () => [
    { path: `Notes/${ID}.md`, snippet: "zebra duplicate of the recent hit", updatedAt: 1, projectSlug: "p" },
    { path: `Notes/x.md`, snippet: `zebra note naming ${OLD}`, updatedAt: 2, projectSlug: "p" },
    { path: `Notes/y.md`, snippet: "zebra plain note", updatedAt: 3, projectSlug: "p" },
  ];

  it("recent window limits the scan, memory dedups by session and maps a named transcript", async () => {
    const r = await combinedSearch("zebra", { projectsDir: cdir, hours: 48, memorySearch: mem });
    expect(r.hits.map((h) => [h.id, h.source])).toEqual([[ID, "recent"]]);
    expect(r.memory.map((m) => [m.id, m.path, m.source])).toEqual([
      [OLD, "Notes/x.md", "memory"],
      ["", "Notes/y.md", "memory"],
    ]);
    expect(r.note).toBeUndefined();
  });

  it("memory down: recent only plus a note, no error", async () => {
    const r = await combinedSearch("zebra", { projectsDir: cdir, hours: 48, memorySearch: async () => { throw new Error("backend down"); } });
    expect(r.hits).toHaveLength(1);
    expect(r.memory).toEqual([]);
    expect(r.note).toContain("memory search unavailable");
  });

  it("the endpoint returns hits then memory, and 200 with a note when memory is down", async () => {
    const ask = (port: number, path: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        http.request({ port, host: "127.0.0.1", path }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        }).end();
      });
    for (const down of [false, true]) {
      const fn: MemorySearchFn = down ? async () => { throw new Error("nope"); } : mem;
      const s = http.createServer((req, res) => {
        handleCockpit(req, res, { get: async () => [] }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { projectsDir: cdir, memorySearch: fn });
      });
      const port = await new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
      try {
        const j = JSON.parse((await ask(port, "/api/sessions/search?q=zebra")).body);
        expect(j.hits.map((h: { id: string }) => h.id)).toEqual([ID]);
        expect(down ? j.memory : j.memory.length).toEqual(down ? [] : 2);
        expect(Boolean(j.note)).toBe(down);
      } finally {
        s.close();
      }
    }
  });
});
