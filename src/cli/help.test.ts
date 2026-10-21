import { describe, expect, it } from "vitest";
import { OPT, type CommandDef, type GroupDef } from "./define.js";
import {
  colorEnabled,
  makeStyle,
  renderCommandHelp,
  renderMarkdown,
  renderMore,
  renderOverview,
  renderTable,
  suggest,
} from "./help.js";
import { parseArgs } from "./parse.js";
import { runCli, type Io } from "./run.js";

const plain = makeStyle(false);
const color = makeStyle(true);

const open: CommandDef = {
  name: "open",
  summary: "Reopen a session",
  description: "Continues a session with its history.",
  args: [{ name: "NAME_OR_ID", summary: "Session name or id" }],
  options: [{ ...OPT.provider }, { ...OPT.dryRun }],
  examples: ["pai open my-session", "pai open 3a9f --provider kimi"],
  seeAlso: ["pai ls"],
  run: () => 0,
};
const rename: CommandDef = {
  name: "rename",
  summary: "Rename",
  description: "Renames.",
  args: [
    { name: "ID", required: true, summary: "Session id" },
    { name: "NAME", required: true, summary: "New name" },
  ],
  examples: ["pai rename 3a9f x"],
  run: () => 0,
};
const pending: CommandDef = { name: "worker", summary: "Workers", description: "Workers", examples: [], run: () => 0 };
const groups: GroupDef[] = [
  { id: "sessions", title: "Sessions", daily: true, commands: [open, rename] },
  { id: "workers", title: "Workers", daily: false, commands: [pending] },
];

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s), style: plain }, out, err };
}

describe("renderCommandHelp", () => {
  const text = renderCommandHelp(["open"], open, plain);
  it("has usage, description, arguments, options, examples and see also", () => {
    expect(text).toContain("Usage  pai open [NAME_OR_ID] [options]");
    expect(text).toContain("Continues a session with its history.");
    expect(text).toMatch(/Arguments\n\s+Argument\s+Required\s+Description/);
    expect(text).toMatch(/Options\n\s+Flag\s+Type\s+Default\s+Description/);
    expect(text).toContain("--provider NAME");
    expect(text).toContain("$ pai open 3a9f --provider kimi");
    expect(text).toContain("See also  pai ls");
  });
  it("is plain text without colour and carries escapes with colour", () => {
    expect(text).not.toContain("\u001b[");
    expect(renderCommandHelp(["open"], open, color)).toContain("\u001b[");
  });
  it("aligns table columns", () => {
    const t = renderTable(["A", "Bee"], [["x", "1"], ["longer", "2"]], plain).split("\n");
    expect(t[2].indexOf("1")).toBe(t[3].indexOf("2"));
  });
});

describe("colorEnabled", () => {
  it("is off for pipes and NO_COLOR, on for a TTY, FORCE_COLOR wins over a pipe", () => {
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
  });
});

describe("suggest (did you mean)", () => {
  const names = ["open", "new", "providers", "rename", "session"];
  it("finds a close name", () => {
    expect(suggest("opne", names)).toBe("open");
    expect(suggest("provider", names)).toBe("providers");
    expect(suggest("renam", names)).toBe("rename");
  });
  it("offers nothing for an unrelated word", () => {
    expect(suggest("zzzzzz", names)).toBeNull();
  });
});

describe("overview and reference", () => {
  it("shows only daily commands and points to pai more", () => {
    const daily: CommandDef = { ...rename, name: "ls", summary: "List sessions", daily: true };
    const text = renderOverview([{ ...groups[0], commands: [open, daily] }, groups[1]], open, "1.2.3", plain);
    expect(text).toContain("pai ls");
    expect(text).toContain("pai NAME");
    expect(text).not.toContain("pai rename");
    expect(text).not.toContain("pai worker");
    expect(text).toContain("more commands: pai more");
  });
  it("lists service controls with the subcommands' own summaries", () => {
    const sub = (name: string, summary: string): CommandDef => ({ ...rename, name, summary, args: [] });
    const svc = (name: string): CommandDef => ({
      ...rename,
      name,
      args: [],
      subcommands: ["status", "start", "stop", "restart"].map((n) => sub(n, `${n} the ${name}`)),
    });
    const text = renderOverview([{ ...groups[0], commands: [open, svc("daemon"), svc("router")] }], open, "1.2.3", plain);
    expect(text).toContain("Services");
    for (const n of ["daemon", "router"]) {
      for (const v of ["status", "start", "stop", "restart"]) expect(text).toMatch(new RegExp(`pai ${n} ${v}\\s+${v} the ${n}`));
    }
  });
  it("help more lists the rest", () => {
    expect(renderMore(groups, plain)).toContain("worker");
  });
  it("markdown reference comes from the same definitions", () => {
    const md = renderMarkdown(groups, "1.2.3");
    expect(md).toContain("### pai open");
    expect(md).toContain("| `--provider NAME` | string | — | Provider to run on");
  });
});

describe("parseArgs", () => {
  it("parses flags, values, = form and --", () => {
    const p = parseArgs(open, ["x", "--provider=kimi", "--dry-run"]);
    expect(p.args.NAME_OR_ID).toBe("x");
    expect(p.opts.provider).toBe("kimi");
    expect(p.dryRun).toBe(true);
  });
  it("reports unknown options with a suggestion", () => {
    expect(() => parseArgs(open, ["--provder", "x"])).toThrow(/did you mean --provider/);
  });
  it("reports a missing required argument by name", () => {
    expect(() => parseArgs(rename, ["only-id"])).toThrow(/missing required argument NAME/);
  });
});

describe("runCli", () => {
  it("unknown command: did you mean, pointer to help, exit 2", async () => {
    const c = capture();
    expect(await runCli(groups, ["opne"], c.io)).toBe(2);
    const e = c.err.join("\n");
    expect(e).toContain('unknown command "opne" — did you mean "open"?');
    expect(e).toContain("pai help");
  });
  it("missing argument shows which one and the Usage line, exit 2", async () => {
    const c = capture();
    expect(await runCli(groups, ["rename", "abc"], c.io)).toBe(2);
    const e = c.err.join("\n");
    expect(e).toContain("missing required argument NAME");
    expect(e).toContain("Usage  pai rename ID NAME");
  });
  it("unknown option: did you mean, exit 2", async () => {
    const c = capture();
    expect(await runCli(groups, ["open", "--provder", "x"], c.io)).toBe(2);
    expect(c.err.join("\n")).toContain("did you mean --provider?");
  });
  it("--help prints the command help, exit 0", async () => {
    const c = capture();
    expect(await runCli(groups, ["open", "--help"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("Usage  pai open");
  });
  it("no arguments prints the overview", async () => {
    const c = capture();
    expect(await runCli(groups, [], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("pai help <command>");
  });
});
