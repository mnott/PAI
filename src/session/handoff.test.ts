import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// PAI_HOME must point at a temp dir before the module is imported.
const home = mkdtempSync(join(tmpdir(), "pai-handoff-"));
process.env.PAI_HOME = join(home, "pai-home");

const { buildHandoffBrief, writeHandoff, appendHandoffLink, resolveTranscript } = await import("./handoff.js");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function entry(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

/** A small synthetic transcript: user requests, edits, bash, assistant texts. */
function fixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pai-handoff-t-"));
  const path = join(dir, `${SESSION_ID}.jsonl`);
  writeFileSync(path, lines.join(""));
  return path;
}

function baseTranscript(): string[] {
  return [
    entry({ type: "user", cwd: "/work/proj", timestamp: "2026-10-22T10:00:00Z", message: { role: "user", content: "first request: fix the parser" } }),
    entry({
      type: "assistant",
      timestamp: "2026-10-22T10:01:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the parser." },
          { type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "/work/proj/src/parser.ts" } },
        ],
      },
    }),
    entry({
      type: "user",
      timestamp: "2026-10-22T10:02:00Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    }),
    entry({
      type: "assistant",
      timestamp: "2026-10-22T10:03:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu2", name: "Write", input: { file_path: "/work/proj/src/lexer.ts" } },
          { type: "tool_use", id: "tu3", name: "Bash", input: { command: "curl -H \"Authorization: Bearer sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\" https://api.example.com" } },
        ],
      },
    }),
    entry({
      type: "user",
      timestamp: "2026-10-22T10:04:00Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu3", content: "Exit code 7" }] },
    }),
    entry({ type: "user", cwd: "/work/proj", timestamp: "2026-10-22T10:05:00Z", message: { role: "user", content: "latest request: run the tests" } }),
    entry({
      type: "assistant",
      timestamp: "2026-10-22T10:06:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "Tests pass; stopping here." }] },
    }),
  ];
}

describe("buildHandoffBrief", () => {
  it("has every section and the right content", () => {
    const brief = buildHandoffBrief(fixture(baseTranscript()));
    for (const title of ["Session", "First request", "Latest request", "Files changed", "Recent commands", "Last steps", "Where it stopped"]) {
      expect(brief).toContain(`## ${title}`);
    }
    expect(brief).toContain(SESSION_ID);
    expect(brief).toContain("/work/proj");
    expect(brief).toContain("2026-10-22T10:00:00Z");
    expect(brief).toContain("2026-10-22T10:06:00Z");
    expect(brief).toContain("first request: fix the parser");
    expect(brief).toContain("latest request: run the tests");
    expect(brief).toContain("/work/proj/src/parser.ts");
    expect(brief).toContain("/work/proj/src/lexer.ts");
    expect(brief).toContain("[exit 7]");
    expect(brief).toContain("Tests pass; stopping here.");
  });

  it("redacts a secret in a Bash command", () => {
    const brief = buildHandoffBrief(fixture(baseTranscript()));
    expect(brief).toContain("[REDACTED]");
    expect(brief).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("truncates a huge transcript under maxBytes with the marker line, oldest sections first", () => {
    const lines = baseTranscript();
    // a huge "Last steps" section and huge commands force the cut
    lines.push(
      entry({
        type: "assistant",
        timestamp: "2026-10-22T10:07:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] },
      })
    );
    const brief = buildHandoffBrief(fixture(lines), { maxBytes: 2048 });
    expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(2048);
    expect(brief).toContain("[truncated to 2048 bytes]");
    // the sections a successor needs survive; the cut ones are gone
    expect(brief).toContain("## Session");
    expect(brief).toContain("## First request");
    expect(brief).toContain("## Latest request");
    expect(brief).toContain("## Files changed");
    expect(brief).not.toContain("## Recent commands");
    expect(brief).not.toContain("## Last steps");
  });

  it("cuts Recent commands before Last steps", () => {
    const lines = baseTranscript();
    for (let i = 0; i < 10; i++) {
      lines.push(
        entry({
          type: "assistant",
          timestamp: `2026-10-22T10:1${i}:00Z`,
          message: { role: "assistant", content: [{ type: "text", text: "s".repeat(400) }] },
        })
      );
    }
    const full = Buffer.byteLength(buildHandoffBrief(fixture(lines)), "utf8");
    const max = full - 20;
    const brief = buildHandoffBrief(fixture(lines), { maxBytes: max });
    expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(max);
    expect(brief).toContain(`[truncated to ${max} bytes]`);
    expect(brief).not.toContain("## Recent commands");
    expect(brief).toContain("## Last steps");
  });
});

describe("writeHandoff", () => {
  beforeEach(() => {
    mkdirSync(process.env.PAI_HOME!, { recursive: true });
  });

  it("writes under PAI_HOME/handoffs with mode 0600 and returns the path", () => {
    const path = writeHandoff("# brief", SESSION_ID);
    expect(path).toContain(join("handoffs", `${SESSION_ID}-`));
    expect(path).toMatch(/-\d{8}-\d{4}\.md$/);
    expect(readFileSync(path, "utf8")).toBe("# brief");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(process.env.PAI_HOME!, "handoffs")).mode & 0o777).toBe(0o700);
  });

  it("appendHandoffLink records {ts, from, to} and never throws", () => {
    appendHandoffLink("from-id", "to-id");
    const line = readFileSync(join(process.env.PAI_HOME!, "handoffs", "links.jsonl"), "utf8").trim().split("\n").pop()!;
    const rec = JSON.parse(line) as { ts: string; from: string; to: string };
    expect(rec.from).toBe("from-id");
    expect(rec.to).toBe("to-id");
    expect(rec.ts).toMatch(/^\d{4}-/);
  });
});

describe("marker detection", () => {
  const MARKER = /\[pai-handoff from=([^\]\s]+)\]/;

  it("extracts the from-id from a continued prompt", () => {
    const m = MARKER.exec('Read /tmp/x.md and continue. [pai-handoff from=abc-123]');
    expect(m?.[1]).toBe("abc-123");
  });

  it("does not match without the marker", () => {
    expect(MARKER.exec("just a prompt")).toBeNull();
  });
});

describe("resolveTranscript", () => {
  it("finds a session by id under the project dir, then sessions/", () => {
    const root = mkdtempSync(join(tmpdir(), "pai-handoff-proj-"));
    process.env.CLAUDE_CONFIG_DIR = root;
    const projectDir = join(root, "projects", "-work-proj");
    mkdirSync(join(projectDir, "sessions"), { recursive: true });
    const live = join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(live, entry({ type: "user", message: { content: "hi" } }));
    expect(resolveTranscript(SESSION_ID, "/work/proj")).toBe(live);
    const archived = join(projectDir, "sessions", "99999999-0000-0000-0000-000000000000.jsonl");
    writeFileSync(archived, entry({ type: "user", message: { content: "hi" } }));
    expect(resolveTranscript("99999999-0000-0000-0000-000000000000", "/work/proj")).toBe(archived);
    expect(resolveTranscript(undefined, "/work/proj")).toBe(live);
    expect(resolveTranscript("nope", "/work/proj")).toBeNull();
  });
});
