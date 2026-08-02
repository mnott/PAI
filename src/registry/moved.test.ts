import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  transcriptFiles,
  cwdOfTranscript,
  scanTranscriptFolders,
  findMovedProjects,
  type RegistryProjectRow,
  type TranscriptFolder,
} from "./moved.js";

let root: string;

function folder(name: string, live: string[], archived: string[] = []): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  for (const [i, cwd] of live.entries()) {
    writeFileSync(join(d, `live-${i}.jsonl`), JSON.stringify({ cwd, type: "user" }) + "\n");
  }
  if (archived.length) {
    mkdirSync(join(d, "sessions"), { recursive: true });
    for (const [i, cwd] of archived.entries()) {
      writeFileSync(
        join(d, "sessions", `old-${i}.jsonl`),
        JSON.stringify({ cwd, type: "user" }) + "\n"
      );
    }
  }
  return d;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pai-moved-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("transcriptFiles", () => {
  it("counts the archived half as well as the live one", () => {
    // session-stop moves all but the newest transcript into sessions/, so a
    // finished project has an empty top level. Counting only the top level
    // reported a busy project as unused — that mistake overstated a real audit
    // of this same problem by a factor of three.
    const d = folder("a", ["/x"], ["/x", "/x"]);
    expect(transcriptFiles(d)).toHaveLength(3);
  });

  it("returns empty for a directory that does not exist", () => {
    expect(transcriptFiles(join(root, "nope"))).toEqual([]);
  });
});

describe("cwdOfTranscript", () => {
  it("reads cwd from the first entry", () => {
    const f = join(root, "t.jsonl");
    writeFileSync(f, JSON.stringify({ cwd: "/Users/me/Project", type: "user" }) + "\n");
    expect(cwdOfTranscript(f)).toBe("/Users/me/Project");
  });

  it("skips entries that carry no cwd rather than giving up", () => {
    const f = join(root, "t.jsonl");
    writeFileSync(
      f,
      JSON.stringify({ type: "summary" }) + "\n" + JSON.stringify({ cwd: "/late" }) + "\n"
    );
    expect(cwdOfTranscript(f)).toBe("/late");
  });

  it("tolerates a truncated final line", () => {
    // Normal for a session still being written to.
    const f = join(root, "t.jsonl");
    writeFileSync(f, JSON.stringify({ cwd: "/ok" }) + "\n" + '{"cwd": "/half');
    expect(cwdOfTranscript(f)).toBe("/ok");
  });

  it("returns null when there is no cwd anywhere, instead of throwing", () => {
    const f = join(root, "t.jsonl");
    writeFileSync(f, JSON.stringify({ type: "summary" }) + "\n");
    expect(cwdOfTranscript(f)).toBeNull();
    expect(cwdOfTranscript(join(root, "missing.jsonl"))).toBeNull();
  });
});

describe("scanTranscriptFolders", () => {
  it("maps a working directory to the folder holding its transcripts", () => {
    folder("enc-a", ["/Users/me/Alpha"]);
    folder("enc-b", ["/Users/me/Beta"]);
    const m = scanTranscriptFolders(root);
    expect(m.get("/Users/me/Alpha")?.[0].name).toBe("enc-a");
    expect(m.get("/Users/me/Beta")?.[0].name).toBe("enc-b");
  });

  it("reports every folder for a path that has more than one", () => {
    // Claude Code's encoding is lossy, and a project moved and moved back
    // leaves both. Reporting one and hiding the other would make the choice
    // silently rather than letting the caller rank them.
    folder("old", ["/Users/me/Alpha"]);
    folder("new", ["/Users/me/Alpha", "/Users/me/Alpha"]);
    expect(scanTranscriptFolders(root).get("/Users/me/Alpha")).toHaveLength(2);
  });

  it("ignores folders with no transcripts at all", () => {
    mkdirSync(join(root, "empty"), { recursive: true });
    expect(scanTranscriptFolders(root).size).toBe(0);
  });
});

describe("findMovedProjects", () => {
  const rows: RegistryProjectRow[] = [
    { id: 1, slug: "alpha", root_path: "/Users/me/Alpha", encoded_dir: "stale-alpha", sessions: 12 },
    { id: 2, slug: "beta", root_path: "/Users/me/Beta", encoded_dir: "enc-beta", sessions: 3 },
  ];
  /** A folder the given path dominates — i.e. genuinely its own. */
  const owned = (name: string, count: number, newest: number): TranscriptFolder => ({
    name,
    count,
    newest,
    matching: 8,
    total: 8,
  });

  const byCwd = new Map<string, TranscriptFolder[]>([
    ["/Users/me/Alpha", [owned("real-alpha", 9, 100)]],
    ["/Users/me/Beta", [owned("enc-beta", 2, 50)]],
  ]);

  it("reports a project whose stored folder yields nothing", () => {
    const moved = findMovedProjects(rows, byCwd, () => false);
    const alpha = moved.find((m) => m.slug === "alpha");
    expect(alpha?.correctDir).toBe("real-alpha");
    expect(alpha?.sessions).toBe(12);
  });

  it("never touches a project the shipped resolver already handles", () => {
    // Rewriting a row that works is churn dressed as a repair, and it would
    // reattach a working project on the strength of a guess.
    expect(findMovedProjects(rows, byCwd, () => true)).toEqual([]);
  });

  it("does not report a project already pointing at the right folder", () => {
    // beta's stored dir IS the correct one; only its resolution failed for
    // some other reason, so there is nothing here to correct.
    const moved = findMovedProjects(rows, byCwd, () => false);
    expect(moved.some((m) => m.slug === "beta")).toBe(false);
  });

  it("prefers the folder with the most history, then the newest", () => {
    const many = new Map<string, TranscriptFolder[]>([
      ["/Users/me/Alpha", [owned("few-recent", 2, 999), owned("many-older", 40, 1)]],
    ]);
    const moved = findMovedProjects([rows[0]], many, () => false);
    expect(moved[0].correctDir).toBe("many-older");
  });

  it("ranks the costliest breakage first", () => {
    const two: RegistryProjectRow[] = [
      { id: 3, slug: "small", root_path: "/s", encoded_dir: "x", sessions: 1 },
      { id: 4, slug: "big", root_path: "/b", encoded_dir: "x", sessions: 99 },
    ];
    const m = new Map<string, TranscriptFolder[]>([
      ["/s", [owned("s-dir", 1, 1)]],
      ["/b", [owned("b-dir", 1, 1)]],
    ]);
    expect(findMovedProjects(two, m, () => false)[0].slug).toBe("big");
  });

  it("refuses a folder the project does not dominate", () => {
    // Measured 2026-08-02: apps/youdrill held 5 transcripts for itself and 3
    // for apps/youdrill/app. Reconnecting `app` there would attach a
    // subdirectory to its parent's history — and the no-session-id fallback,
    // which takes the newest transcript in the folder, would then read a
    // sibling's work as this project's. A missed repair costs nothing.
    const subdir: RegistryProjectRow[] = [
      { id: 9, slug: "app", root_path: "/Users/me/proj/app", encoded_dir: "stale", sessions: 1 },
    ];
    const shared = new Map<string, TranscriptFolder[]>([
      ["/Users/me/proj/app", [{ name: "proj-dir", count: 9, newest: 100, matching: 3, total: 8 }]],
    ]);
    expect(findMovedProjects(subdir, shared, () => false)).toEqual([]);
  });

  it("accepts a folder where the project is a clear majority", () => {
    const solo: RegistryProjectRow[] = [
      { id: 10, slug: "real", root_path: "/Users/me/real", encoded_dir: "stale", sessions: 2 },
    ];
    const mostly = new Map<string, TranscriptFolder[]>([
      ["/Users/me/real", [{ name: "real-dir", count: 9, newest: 100, matching: 7, total: 8 }]],
    ]);
    expect(findMovedProjects(solo, mostly, () => false)[0].correctDir).toBe("real-dir");
  });

  it("says nothing about a project with no transcripts anywhere", () => {
    // There is no repair to offer — that is a different problem, and inventing
    // a destination would be worse than reporting none.
    const orphan: RegistryProjectRow[] = [
      { id: 5, slug: "gone", root_path: "/nowhere", encoded_dir: "x", sessions: 4 },
    ];
    expect(findMovedProjects(orphan, byCwd, () => false)).toEqual([]);
  });
});
