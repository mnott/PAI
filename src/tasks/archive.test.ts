import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSlug, archivePath, renderArchive, writeArchive } from "./archive.js";
import type { Task } from "./types.js";

const TASK: Task = {
  id: "6hC4McG6",
  title: "Decide: apply to the EMA Partners CIO mandate, yes or no",
  body: "THE ROLE. Chief Information Officer, Raum Zürich.",
  owner: { project: "jobs-matthias", rootPath: "/jm", source: "label" },
  due: "2026-08-07",
  priority: "p1",
  labels: ["pai:jobs-matthias"],
};

const COMMENTS = [
  { id: "c1", content: "What do you mean by counterparty?", postedAt: "2026-08-02T12:51:02.123Z" },
  { id: "c2", content: "Their core is SAP and you ran SAP's cloud ops.", postedAt: "2026-08-02T13:02:44.000Z" },
];

describe("archiveSlug", () => {
  it("includes the id, so the path survives a title change", () => {
    // Stability is what makes rewriting idempotent instead of accumulating
    // near-duplicate files every time someone edits the title.
    expect(archiveSlug(TASK)).toContain("6hC4McG6");
  });

  it("keeps accented characters rather than mangling them", () => {
    expect(archiveSlug({ id: "x", title: "Échéances à Genève" })).toBe("échéances-à-genève - x");
  });

  it("falls back to the bare id when the title has nothing usable", () => {
    expect(archiveSlug({ id: "x", title: "🎯🎯" })).toBe("x");
    expect(archiveSlug({ id: "x", title: "   " })).toBe("x");
  });
});

describe("renderArchive", () => {
  const out = renderArchive(TASK, COMMENTS, "2026-08-02T14:00:00.000Z");

  it("keeps the description, not just the comments", () => {
    // The description is usually the reasoning; without it the comments are
    // answers to a question nobody recorded.
    expect(out).toContain("Chief Information Officer");
  });

  it("keeps every comment, with its date", () => {
    expect(out).toContain("What do you mean by counterparty?");
    expect(out).toContain("ran SAP's cloud ops");
    expect(out).toContain("2026-08-02 12:51:02");
  });

  it("records the owner and the task id in frontmatter", () => {
    expect(out).toContain("task_id: 6hC4McG6");
    expect(out).toContain("owner: jobs-matthias");
  });

  it("states an empty thread rather than omitting the section", () => {
    // Only reached when a caller renders directly. writeArchive declines to
    // create a file at all when there is no discussion — see below.
    const empty = renderArchive(TASK, [], "2026-08-02T14:00:00.000Z");
    expect(empty).toContain("Discussion (0)");
    expect(empty).toContain("No comments were posted");
  });

  it("survives a comment with no timestamp", () => {
    const r = renderArchive(TASK, [{ id: "c", content: "hi" }], "2026-08-02T14:00:00.000Z");
    expect(r).toContain("date unknown");
    expect(r).toContain("hi");
  });
});

describe("writeArchive", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pai-archive-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes into the owning project's notes", () => {
    const r = writeArchive(root, TASK, COMMENTS, "2026-08-02T14:00:00.000Z");
    expect(r.written).toBe(true);
    expect(r.commentCount).toBe(2);
    expect(r.path).toBe(archivePath(root, TASK));
    expect(readFileSync(r.path, "utf-8")).toContain("counterparty");
  });

  it("writes nothing at all when there was no discussion", () => {
    // The point is preserving a conversation that completing the task would
    // bury. Where none happened, a file saying so is noise — and enough of it
    // buries the notes that do carry something.
    const r = writeArchive(root, TASK, [], "2026-08-02T14:00:00.000Z");
    expect(r.written).toBe(false);
    expect(r.skipped).toBe("no-discussion");
    expect(existsSync(r.path)).toBe(false);
  });

  it("does not rewrite an unchanged file", () => {
    // A recurring task is archived on every completion. Rewriting an identical
    // file daily would churn its mtime and make the indexer re-read it for
    // nothing.
    writeArchive(root, TASK, COMMENTS, "2026-08-02T14:00:00.000Z");
    const again = writeArchive(root, TASK, COMMENTS, "2026-08-02T14:00:00.000Z");
    expect(again.written).toBe(false);
  });

  it("rewrites when a new comment has arrived", () => {
    writeArchive(root, TASK, COMMENTS, "2026-08-02T14:00:00.000Z");
    const more = [...COMMENTS, { id: "c3", content: "Decided: apply.", postedAt: "2026-08-02T15:00:00.000Z" }];
    const r = writeArchive(root, TASK, more, "2026-08-02T14:00:00.000Z");
    expect(r.written).toBe(true);
    expect(readFileSync(r.path, "utf-8")).toContain("Decided: apply.");
  });

  it("never reports 'already saved' for a file it could not read", () => {
    // The guarantee is not that it always succeeds — it is that it never
    // claims the discussion is safely on disk without having verified it.
    // Treating a read failure as "already up to date" would skip the write
    // this module exists to perform, and say so cheerfully.
    const path = archivePath(root, TASK);
    mkdirSync(path, { recursive: true }); // a directory where the file should be

    let result: { written: boolean } | null = null;
    try {
      result = writeArchive(root, TASK, COMMENTS, "2026-08-02T14:00:00.000Z");
    } catch {
      // Surfacing the failure is the acceptable outcome: the caller reports it.
      return;
    }
    expect(result?.written).not.toBe(false);
  });

  it("creates the notes directory when it does not exist yet", () => {
    const fresh = join(root, "brand-new");
    const r = writeArchive(fresh, TASK, COMMENTS, "2026-08-02T14:00:00.000Z");
    expect(readFileSync(r.path, "utf-8")).toContain("# Decide:");
  });
});
