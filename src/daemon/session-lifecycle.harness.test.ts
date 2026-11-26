/**
 * Session-note lifecycle harness (APPS/PAI#35).
 *
 * Drives the real handleSessionSummary / note / checkpoint code over synthetic
 * Claude Code transcripts with a scripted summarizer. Everything lives in temp
 * dirs: HOME, PAI_HOME, CLAUDE_CONFIG_DIR and the notes dirs. No real notes,
 * transcripts or models are touched.
 *
 * Phases 1-7 are separate `it`s; a pass/fail table prints at the end.
 * Stress mode: seeded random phase orders (PAI_STRESS_SEEDS, default 3;
 * PAI_STRESS=1 raises the default to 300).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptBuilder } from "./test-support/transcript-builder.js";
import { FakeSummarizer, summaryText } from "./test-support/fake-summarizer.js";

const root = mkdtempSync(join(tmpdir(), "pai-lifecycle-"));
process.env.HOME = join(root, "home");
process.env.PAI_HOME = join(root, "pai-home");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.PAI_HOME, { recursive: true });

vi.mock("../storage/factory.js", () => ({ getRegistryBackend: async () => { throw new Error("no registry in harness"); } }));
vi.mock("../storage/session-note-registry.js", () => ({ drainRenameQueue: async () => undefined }));
vi.mock("../memory/kg-extraction.js", () => ({
  extractAndStoreTriples: async () => undefined,
  findClaudeBinary: () => null,
}));
vi.mock("../workers/helper.js", () => ({ helperComplete: async () => null }));

const W = await import("./session-summary-worker.js");
const U = await import("../hooks/ts/lib/project-utils/index.js");
const CP = await import("../session/checkpoint-block.js");

const fake = new FakeSummarizer();
W.setSummarizerForTests(fake.fn);

const MIN = 60_000;
let seq = 0;
const T0 = Date.now();
const setNow = (ms: number) => { vi.setSystemTime(ms); };
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function mkProject(name: string): string {
  const dir = join(root, "proj", name);
  mkdirSync(join(dir, "Notes"), { recursive: true });
  return dir;
}
function notesOf(cwd: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/^\d{3,4} - .*\.md$/.test(e.name)) out.push(join(d, e.name));
    }
  };
  walk(join(cwd, "Notes"));
  return out.sort();
}
const read = (p: string) => readFileSync(p, "utf-8");
const base = (p: string) => p.split("/").pop()!;
const stem = (p: string) => base(p).replace(/\.md$/, "");
const stateOf = (id: string) => JSON.parse(readFileSync(join(process.env.PAI_HOME!, "summary-sessions.json"), "utf-8"))[id] as { at: number; offset: number };

/** Session-start hook (load-project-context): a stub note for the project. */
function sessionStart(cwd: string): string {
  return U.createSessionNote(U.findNotesDir(cwd).path, cwd.split("/").pop()!);
}
/** What the Stop hook enqueues each Stop. */
async function stop(cwd: string, id: string, tp: string, extra: Record<string, unknown> = {}): Promise<void> {
  await W.handleSessionSummary({ cwd, sessionId: id, transcriptPath: tp, trigger: "stop", ...extra } as never);
}

// shared scenario state across the ordered phases
const A = mkProject("alpha-app");
const B = mkProject("beta-site");
const sid = uuid();
const tr = new TranscriptBuilder(join(root, "claude", "projects", "t", `${sid}.jsonl`), sid, A);
const results: Record<string, string> = {};

function phase(name: string, fn: () => Promise<void> | void) {
  it(name, async () => {
    try { await fn(); results[name] = "PASS"; } catch (e) { results[name] = "FAIL"; throw e; }
  });
}

describe("session note lifecycle", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); setNow(T0); });
  afterAll(() => {
    const rows = Object.entries(results).map(([k, v]) => `  ${v.padEnd(5)} ${k}`).join("\n");
    process.stderr.write(`\n=== phase table ===\n${rows}\n`);
  });

  phase("1 session start creates a note", () => {
    const n = sessionStart(A);
    expect(notesOf(A)).toHaveLength(1);
    expect(base(n)).toMatch(/^0001 - \d{4}-\d{2}-\d{2} - New Session\.md$/);
  });

  phase("2 first real work gives the note a conversation name", async () => {
    tr.turn("fixing the login redirect loop in the auth middleware", 500)
      .tool("Bash", 80_000).turn("login redirect loop cookie domain", 500);
    fake.push(summaryText("Login redirect loop fix", "Fix Login Redirect Loop", ["Found the cookie domain mismatch", "Patched auth middleware"]));
    setNow(T0 + 2 * MIN);
    await stop(A, sid, tr.path);
    const notes = notesOf(A);
    expect(notes).toHaveLength(1);
    expect(base(notes[0])).toMatch(/^0001 - .* - Fix Login Redirect Loop\.md$/);
    expect(base(notes[0])).not.toContain("New Session");
    expect(read(notes[0])).toMatch(/^# Session 0001: Fix Login Redirect Loop$/m);
    expect(read(notes[0])).toContain("Patched auth middleware");
    expect(stateOf(sid).offset).toBeGreaterThan(0);
  });

  phase("3 periodic update on Stop between compacts", async () => {
    const before = read(notesOf(A)[0]);
    const off0 = stateOf(sid).offset;
    // small amount of new text, 3 minutes later: no run
    tr.turn("login redirect loop cookie domain follow up", 300);
    setNow(T0 + 5 * MIN);
    fake.push(summaryText("Login redirect loop fix", "Fix Login Redirect Loop", ["SHOULD NOT RUN"]));
    await stop(A, sid, tr.path);
    expect(read(notesOf(A)[0])).toBe(before);
    fake.queue = [];
    // enough new chars: runs even though the 30 min interval has not passed
    tr.turn("login redirect loop cookie domain regression test", 7000);
    setNow(T0 + 6 * MIN);
    fake.push(summaryText("Login redirect loop fix", "Fix Login Redirect Loop", ["Added regression test for cookie domain"]));
    await stop(A, sid, tr.path);
    expect(read(notesOf(A)[0])).toContain("Added regression test for cookie domain");
    expect(stateOf(sid).offset).toBeGreaterThan(off0);
    // time trigger: little text but >= 10 minutes since the last write
    const off1 = stateOf(sid).offset;
    tr.turn("login redirect loop cookie domain review", 300);
    setNow(T0 + 20 * MIN);
    fake.push(summaryText("Login redirect loop fix", "Fix Login Redirect Loop", ["Reviewed the final diff"]));
    await stop(A, sid, tr.path);
    expect(read(notesOf(A)[0])).toContain("Reviewed the final diff");
    expect(stateOf(sid).offset).toBeGreaterThan(off1);
  });

  phase("4 topic change makes a new, linked note", async () => {
    tr.turn("now the invoice pdf export layout needs a rewrite with tables", 7000);
    setNow(T0 + 40 * MIN);
    fake.push(summaryText("Invoice PDF export layout", "Rewrite Invoice PDF Export", ["Rebuilt the invoice table layout"]));
    await stop(A, sid, tr.path);
    const notes = notesOf(A);
    expect(notes).toHaveLength(2);
    const [n1, n2] = notes;
    expect(base(n1)).toMatch(/^0001 - .* - Fix Login Redirect Loop\.md$/);
    expect(base(n2)).toMatch(/^0002 - .* - Rewrite Invoice Pdf Export\.md$/);
    expect(read(n1)).toContain("**Status:** Completed");
    expect(read(n1)).toContain(`[[${stem(n2)}]]`);
    expect(read(n2)).toContain(`[[${stem(n1)}]]`);
    expect(read(n2)).toContain("**Status:** In Progress");
    expect(read(n2)).not.toContain("Added regression test");
    // the session follows the new note afterwards
    tr.turn("invoice pdf export layout tables follow up", 7000);
    setNow(T0 + 41 * MIN);
    fake.push(summaryText("Invoice PDF export layout", "Rewrite Invoice PDF Export", ["Added page breaks to the invoice"]));
    await stop(A, sid, tr.path);
    expect(notesOf(A)).toHaveLength(2);
    expect(read(notesOf(A)[1])).toContain("Added page breaks");
    expect(read(notesOf(A)[0])).not.toContain("Added page breaks");
  });

  phase("5 cwd moves to another project", async () => {
    const stubB = sessionStart(B);
    expect(base(stubB)).toContain("New Session");
    tr.moveTo(B).turn("switching over to the beta site newsletter signup form", 7000);
    setNow(T0 + 60 * MIN);
    fake.push(summaryText("Newsletter signup form", "Build Newsletter Signup Form", ["Created the signup form component"]));
    await stop(B, sid, tr.path);
    const nb = notesOf(B);
    expect(nb).toHaveLength(1);
    expect(base(nb[0])).toMatch(/Build Newsletter Signup Form\.md$/);
    expect(read(nb[0]).length).toBeGreaterThan(600);
    expect(read(nb[0])).toContain("Created the signup form component");
    const na = notesOf(A);
    expect(na).toHaveLength(2);
    expect(read(na[1])).toContain(`[[${stem(nb[0])}]]`);
    expect(read(na[1])).toContain("**Status:** Completed");
    expect(read(nb[0])).toContain(`[[${stem(na[1])}]]`);
    // later work lands in B only
    tr.turn("newsletter signup form validation messages", 7000);
    setNow(T0 + 61 * MIN);
    fake.push(summaryText("Newsletter signup form", "Build Newsletter Signup Form", ["Added validation messages"]));
    await stop(B, sid, tr.path);
    expect(read(notesOf(B)[0])).toContain("Added validation messages");
    for (const n of notesOf(A)) expect(read(n)).not.toContain("signup form component");
    expect(read(notesOf(B)[0]).match(/Created the signup form component/g)).toHaveLength(1);
  });

  phase("6 compact and resume keep cursor and Continue", async () => {
    writeFileSync(join(B, "TODO.md"), "# TODO\n\n## Tasks\n\n- [ ] ship the form\n");
    const body = "### Where I am\nValidation messages done.\n\n### Next\n- wire the API\n- write tests\n";
    const r = CP.applyContinue({ authored: "model", sessionLine: "Newsletter", sessionId: sid, cwd: B, rootPath: B, body });
    expect(r.action).toBe("written");
    const note = notesOf(B)[0];
    CP.appendCheckpointToNote(note, body, "2026-11-26T10:00:00.000Z");
    const cursor = stateOf(sid).offset;
    // "daemon restart": all state is on disk; resume with a new Stop
    W.resetTopicProbeState();
    tr.turn("newsletter signup form double opt in mail", 7000);
    setNow(T0 + 90 * MIN);
    fake.push(summaryText("Newsletter signup form", "Build Newsletter Signup Form", ["Implemented double opt-in mail"]));
    const pCount = fake.prompts.length;
    await stop(B, sid, tr.path);
    expect(stateOf(sid).offset).toBeGreaterThan(cursor);
    const prompt = fake.prompts[pCount];
    expect(prompt).toContain("double opt in mail");
    expect(prompt).not.toContain("login redirect loop");
    const text = read(note);
    expect(text.match(/Implemented double opt-in mail/g)).toHaveLength(1);
    expect(text.match(/## Pause Checkpoint/g)).toHaveLength(1);
    const todo = read(join(B, "TODO.md"));
    expect(todo).toContain("## Continue");
    expect(todo).toContain("wire the API");
    expect(todo).toContain("write tests");
  });

  phase("7 end finalizes title and status", () => {
    const note = notesOf(B)[0];
    const fin = U.finalizeSessionNote(note, "Newsletter signup form shipped.");
    const text = read(fin);
    expect(text).toContain("**Status:** Completed");
    expect(base(fin)).not.toContain("New Session");
    expect(base(fin)).toMatch(/^0\d{3} - \d{4}-\d{2}-\d{2} - .+\.md$/);
    expect(text).toMatch(/^# Session \d+: Build Newsletter Signup Form$/m);
  });
});

// ---------------------------------------------------------------------------
// Stress mode
// ---------------------------------------------------------------------------

const STRESS_SEEDS = Number(process.env.PAI_STRESS_SEEDS ?? (process.env.PAI_STRESS === "1" ? 300 : 3));

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  ["Login redirect loop", "cookie domain mismatch in auth middleware"],
  ["Invoice pdf export", "table layout page breaks for invoices"],
  ["Newsletter signup form", "double opt in mail validation messages"],
  ["Postgres index tuning", "slow query planner btree vacuum"],
  ["Kubernetes rollout", "helm chart deployment replicas probes"],
  ["Dark mode palette", "color tokens contrast theme switch"],
];

function checkInvariants(dirs: string[], cursors: Map<string, number[]>, label: string): void {
  const markerTitle = new Set<string>();
  for (const d of dirs) {
    const seenNum = new Set<string>();
    for (const n of notesOf(d)) {
      const text = read(n);
      const num = base(n).match(/^(\d+)/)![1];
      expect(seenNum.has(num), `${label}: duplicate number ${num} in ${d}`).toBe(false);
      seenNum.add(num);
      const title = text.match(/^# Session \d+: (.+)$/m)?.[1] ?? "";
      for (const m of text.matchAll(/<!-- SESSION: (\S+) -->/g)) {
        const k = `${m[1]}|${title}`;
        expect(markerTitle.has(k), `${label}: two live notes with marker+title ${k}`).toBe(false);
        markerTitle.add(k);
      }
      const bullets = [...text.matchAll(/^- (Did .+)$/gm)].map((m) => m[1]);
      expect(new Set(bullets).size, `${label}: duplicated work bullet in ${base(n)}`).toBe(bullets.length);
      expect(base(n), `${label}: New Session left`).not.toContain("New Session");
      if (/\*\*Status:\*\* Completed/.test(text)) {
        expect(text, `${label}: closed note ${base(n)} lacks link`).toMatch(/\[\[[^\]]+\]\]/);
      }
    }
  }
  for (const [id, s] of cursors) {
    for (let i = 1; i < s.length; i++) expect(s[i], `${label}: cursor not monotonic for ${id}`).toBeGreaterThanOrEqual(s[i - 1]);
  }
}

describe("session note lifecycle stress", () => {
  it(`seeded random runs (${STRESS_SEEDS} seeds)`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let runs = 0, failures = 0, step = 0;
    const failed: string[] = [];
    for (let seed = Number(process.env.PAI_STRESS_FROM ?? 1); seed <= STRESS_SEEDS; seed++) { // PAI_STRESS_FROM=n replays from one seed
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const proj = [mkProject(`s${seed}-a`), mkProject(`s${seed}-b`)];
      const nSessions = 1 + Math.floor(rnd() * 2);
      const sessions = Array.from({ length: nSessions }, (_, i) => {
        const id = uuid();
        return { id, tb: new TranscriptBuilder(join(root, "claude", "projects", `s${seed}`, `${id}.jsonl`), id, proj[0]), cwd: proj[0], idx: i, topic: 0, started: false };
      });
      const cursors = new Map<string, number[]>();
      let clock = Date.now();
      fake.reset();
      fake.fallback = (prompt) => {
        const t = TOPICS.find((x) => prompt.includes(x[1].split(" ")[0])) ?? TOPICS[0];
        return summaryText(t[0], t[0], [`Did ${t[0]} step ${++step}`]);
      };
      const steps = 12 + Math.floor(rnd() * 12);
      try {
        for (let s = 0; s < steps; s++) {
          const ses = pick(sessions);
          const act = rnd();
          clock += Math.floor(rnd() * 15 * MIN);
          setNow(clock);
          if (!ses.started) { sessionStart(ses.cwd); ses.started = true; }
          if (act < 0.2) ses.topic = Math.floor(rnd() * TOPICS.length);
          if (act > 0.93 && ses.idx === 0 && ses.cwd === proj[0]) { ses.tb.user("moving on to the other project"); ses.cwd = proj[1]; ses.tb.moveTo(proj[1]); sessionStart(ses.cwd); }
          const [name, words] = TOPICS[ses.topic];
          ses.tb.tool("Bash", 20_000 + Math.floor(rnd() * 200_000)).turn(`${name}: ${words}`, 800 + Math.floor(rnd() * 8000));
          if (act > 0.5 && act < 0.6) W.resetTopicProbeState(); // daemon restart
          const calls = act > 0.8 ? 3 : 1; // concurrent summaries
          await Promise.all(Array.from({ length: calls }, () => stop(ses.cwd, ses.id, ses.tb.path)));
          try {
            const arr = cursors.get(ses.id) ?? [];
            arr.push(stateOf(ses.id).offset); cursors.set(ses.id, arr);
          } catch { /* no state yet */ }
        }
        checkInvariants(proj, cursors, `seed ${seed}`);
      } catch (e) {
        failures++; failed.push(`seed ${seed}: ${(e as Error).message.split("\n")[0]}`);
      }
      runs++;
    }
    vi.useRealTimers();
    process.stderr.write(`\n=== stress: seeds=${STRESS_SEEDS} runs=${runs} failures=${failures}\n${failed.slice(0, 10).join("\n")}\n`);
    expect(failures, failed.slice(0, 5).join("; ")).toBe(0);
  }, 600_000);
});

afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
