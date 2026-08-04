import { describe, it, expect, vi, afterEach } from "vitest";
import { dueField, warnIfTruncated, ownerContainers } from "./todoist.js";

describe("ownerContainers", () => {
  /**
   * Ownership belongs to the sub-projects directly under the root. Anything
   * deeper is a folder — a heading inside one owner's inbox, not a new owner.
   *
   * Before 2026-08-02 this took the root and its direct children only, so a
   * grandchild was not merely unrouted but never QUERIED. The user filed
   * eighteen tasks into Claude/Jobs Alpha/Executive Search, it looked tidy,
   * and nothing was ever dispatched.
   */
  const ROOT = "root";
  const p = (id: string, name: string, parent_id?: string, extra = {}) =>
    ({ id, name, parent_id, ...extra }) as never;

  const tree = [
    p(ROOT, "Claude"),
    p("jm", "Jobs Alpha", ROOT),
    p("exec", "Executive Search", "jm"),
    p("deep", "Firms", "exec"),
    p("jg", "Jobs Beta", ROOT),
    p("outside", "Privates", undefined),
    p("outside-kid", "Medical", "outside"),
  ];

  it("gives a grandchild the owner of its top-level ancestor", () => {
    const m = ownerContainers(tree, ROOT);
    expect(m.get("exec")?.ownerName).toBe("Jobs Alpha");
  });

  it("keeps inheriting at any depth, not just one level down", () => {
    // A folder inside a folder is still just a folder.
    const m = ownerContainers(tree, ROOT);
    expect(m.get("deep")?.ownerName).toBe("Jobs Alpha");
  });

  it("leaves the root itself unowned, so its tasks stay unrouted", () => {
    const m = ownerContainers(tree, ROOT);
    expect(m.has(ROOT)).toBe(true);
    expect(m.get(ROOT)?.ownerName).toBeNull();
  });

  it("excludes anything outside the bus subtree entirely", () => {
    const m = ownerContainers(tree, ROOT);
    expect(m.has("outside")).toBe(false);
    expect(m.has("outside-kid")).toBe(false);
  });

  it("drops archived and deleted projects and everything under them", () => {
    const m = ownerContainers(
      [p(ROOT, "Claude"), p("gone", "Old", ROOT, { is_archived: true }), p("kid", "Sub", "gone")],
      ROOT
    );
    expect(m.has("gone")).toBe(false);
    expect(m.has("kid")).toBe(false);
  });

  it("returns nothing when the root is missing, rather than guessing", () => {
    expect(ownerContainers([p("a", "A")], ROOT).size).toBe(0);
  });

  it("excludes a shared project, and everything under it", () => {
    // Inheriting down a subtree means a project only has to be MOVED under the
    // root to gain dispatch rights. For one the user owns that is the point;
    // for a shared one it lets a collaborator write a work order that spawns a
    // terminal and types into it.
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const m = ownerContainers(
      [
        p(ROOT, "Claude"),
        p("shared", "Household", ROOT, { is_shared: true }),
        p("under", "Errands", "shared"),
        p("mine", "Jobs Alpha", ROOT),
      ],
      ROOT
    );
    expect(m.has("shared")).toBe(false);
    expect(m.has("under")).toBe(false);
    expect(m.has("mine")).toBe(true);
    spy.mockRestore();
  });

  it("says which project it skipped, rather than narrowing in silence", () => {
    // A boundary that narrows quietly is the same defect as one that widens
    // quietly: the tasks simply never appear and nothing explains why.
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    ownerContainers([p(ROOT, "Claude"), p("s", "Household", ROOT, { is_shared: true })], ROOT);
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Household");
    expect(out).toContain("collaborator");
    spy.mockRestore();
  });

  it("terminates on a parent cycle instead of hanging the poller", () => {
    // The API should never produce this; a bad write could, and a poller that
    // never returns is worse than one that drops a project.
    const cyclic = [p(ROOT, "Claude"), p("a", "A", ROOT), p("b", "B", "a"), p("a2", "A", "b")];
    (cyclic[1] as unknown as { parent_id: string }).parent_id = "b";
    expect(() => ownerContainers(cyclic, ROOT)).not.toThrow();
  });
});

describe("warnIfTruncated", () => {
  /**
   * Todoist caps a task description at 16,383 characters and enforces it by
   * TRUNCATION, not rejection — the request returns 200 and reports success.
   * Measured 2026-08-02: a 19,457-character runbook stored as 16,383, losing
   * the close-out section including the completion command, silently.
   */
  const warned = () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return {
      spy,
      output: () => spy.mock.calls.map((c) => String(c[0])).join(""),
    };
  };

  afterEach(() => vi.restoreAllMocks());

  it("warns, with both counts, when the server shortened the text", () => {
    const { output } = warned();
    warnIfTruncated("task description", "x".repeat(19457), "x".repeat(16383));
    expect(output()).toContain("truncated");
    expect(output()).toContain("19457");
    expect(output()).toContain("16383");
    expect(output()).toContain("3074");
  });

  it("says nothing when the text came back whole", () => {
    // The check must be silent in the normal case or it becomes noise and
    // stops being read — which is how a real warning turns into background.
    const { output } = warned();
    warnIfTruncated("task description", "abc", "abc");
    expect(output()).toBe("");
  });

  it("says nothing when there was nothing to send", () => {
    const { output } = warned();
    warnIfTruncated("task description", undefined, "");
    warnIfTruncated("task description", "", "");
    expect(output()).toBe("");
  });

  it("does not warn when the server returned MORE than was sent", () => {
    // Some fields come back normalised or decorated. Only shrinkage is loss.
    const { output } = warned();
    warnIfTruncated("comment", "abc", "abc (edited)");
    expect(output()).toBe("");
  });
});

describe("dueField", () => {
  it("sends strict ISO as due_date, untouched by the parser", () => {
    // Already unambiguous, and Todoist's natural-language parser is
    // locale-sensitive — no reason to route this through it.
    expect(dueField("2026-08-02")).toEqual({ due_date: "2026-08-02" });
  });

  it("sends natural language as due_string", () => {
    // Reported 2026-08-01: these were sent as due_date and came back HTTP 400,
    // while --help promised "ISO or natural language".
    expect(dueField("tomorrow")).toEqual({ due_string: "tomorrow" });
    expect(dueField("next monday")).toEqual({ due_string: "next monday" });
  });

  it("sends recurrence as due_string — the case that made routines impossible", () => {
    // Recurrence is only expressible through due_string. Without it there is no
    // way to create a self-rescheduling trigger task at all.
    expect(dueField("every day")).toEqual({ due_string: "every day" });
    expect(dueField("every morning")).toEqual({ due_string: "every morning" });
    expect(dueField("every monday at 9")).toEqual({ due_string: "every monday at 9" });
  });

  it("omits the field entirely when there is no due value", () => {
    // Must be absent, not null: writing the due field at all can clear an
    // existing recurrence.
    expect(dueField(undefined)).toEqual({});
    expect(dueField(null)).toEqual({});
    expect(dueField("")).toEqual({});
    expect(dueField("   ")).toEqual({});
  });

  it("does not mistake a partial or malformed date for ISO", () => {
    // These must reach the parser rather than 400 against due_date.
    expect(dueField("2026-08")).toEqual({ due_string: "2026-08" });
    expect(dueField("Aug 2 2026")).toEqual({ due_string: "Aug 2 2026" });
    expect(dueField("2026-08-02T10:00")).toEqual({ due_string: "2026-08-02T10:00" });
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(dueField("  2026-08-02  ")).toEqual({ due_date: "2026-08-02" });
    expect(dueField("  every day ")).toEqual({ due_string: "every day" });
  });
});
