/**
 * session-detail.test.ts — the per-session drill-down: transcript parsing on a
 * synthetic transcript, and the GET /api/session/<id>/detail endpoint.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionDetail } from "./session-detail.js";
import { handleCockpit } from "./cockpit.js";
import { withCockpitToken } from "./cockpit-auth.js";
import { fakeAnthropic } from "../utils/fake-secret.js";

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

describe("GET /api/session/<id>/detail", () => {
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
