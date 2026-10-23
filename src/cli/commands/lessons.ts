/** `pai lessons ...`: review-gated lessons (candidate, approved, rejected, superseded). */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPT, CliError, type ArgDef, type CommandDef, type OptDef } from "../define.js";
import { claudeProjectsDir } from "../../config/pai-home.js";
import {
  LESSON_KINDS, LESSON_STATES, addLesson, draftFromTranscript, getLesson, listLessons, promoteLesson, proposeFromTranscript, setState,
  type Lesson, type LessonKind, type LessonState,
} from "../../memory/lessons.js";

const ID: ArgDef = { name: "ID", required: true, summary: "Lesson id (its file name without .md)" };

function state(v: unknown): LessonState | undefined {
  if (v === undefined) return undefined;
  if (!LESSON_STATES.includes(v as LessonState)) throw new CliError(`unknown state "${v}" (${LESSON_STATES.join("|")})`);
  return v as LessonState;
}

function row(l: Lesson): string {
  return `${l.id}  [${l.state}] ${l.kind}  ${l.project}  ${l.title}`;
}

function wrap<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
}

/** Newest transcript of the current directory under ~/.claude/projects. */
function newestTranscriptOfCwd(): string | null {
  const dir = join(claudeProjectsDir(), process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }));
  files.sort((a, b) => b.m - a.m);
  return files[0]?.f ?? null;
}

const transition = (name: string, to: LessonState, summary: string): CommandDef => ({
  name,
  summary,
  description: `${summary}. Only candidates can be ${name}d.`,
  args: [ID],
  examples: [`pai lessons ${name} my-lesson`],
  run: (ctx) => {
    const l = wrap(() => setState(ctx.args.ID as string, to));
    console.log(`${l.id}: ${l.state}`);
    return 0;
  },
});

export const lessonsCommand: CommandDef = {
  name: "lessons",
  summary: "Review-gated lessons for agents",
  description: "A short curated memory layer, one Markdown file per lesson in the PAI home. Candidates only reach agents once approved.",
  examples: ["pai lessons list --state candidate", "pai lessons propose", "pai lessons approve my-lesson"],
  seeAlso: ["pai memory"],
  subcommands: [
    {
      name: "list",
      summary: "List lessons",
      description: "Lists lessons, optionally filtered by state or project.",
      options: [
        { name: "state", type: "string", value: "S", summary: "candidate, approved, rejected or superseded" },
        { name: "project", type: "string", value: "P", summary: "Project slug or global" },
        { ...OPT.json, summary: "Print JSON" } as OptDef,
      ],
      examples: ["pai lessons list", "pai lessons list --state approved --project global"],
      run: (ctx) => {
        const ls = wrap(() => listLessons({ state: state(ctx.opts.state), project: ctx.opts.project as string | undefined }));
        if (ctx.opts.json === true) console.log(JSON.stringify(ls, null, 2));
        else if (ls.length === 0) console.log("No lessons.");
        else for (const l of ls) console.log(row(l));
        return 0;
      },
    },
    {
      name: "show",
      summary: "Show one lesson",
      description: "Prints a lesson with its frontmatter fields and body.",
      args: [ID],
      examples: ["pai lessons show my-lesson"],
      run: (ctx) => {
        const l = getLesson(ctx.args.ID as string);
        if (!l) throw new CliError(`lesson not found: ${ctx.args.ID}`);
        console.log(row(l));
        console.log(`applies when: ${l.applies_when || "(not set)"}`);
        console.log(`evidence: ${l.evidence.join(", ") || "(none)"}`);
        if (l.superseded_by) console.log(`superseded by: ${l.superseded_by}`);
        console.log(`\n${l.body}`);
        return 0;
      },
    },
    {
      name: "add",
      summary: "Add a candidate lesson",
      description: "Creates a lesson in the candidate state; approve it after review.",
      options: [
        { name: "title", type: "string", value: "T", summary: "Short title" },
        { name: "kind", type: "string", value: "K", summary: LESSON_KINDS.join(", ") },
        { name: "applies-when", type: "string", value: "W", summary: "One sentence: when the lesson applies" },
        { name: "project", type: "string", value: "P", summary: "Project slug (default: global)" },
        { name: "body", type: "string", value: "B", summary: "The lesson in 1-5 sentences" },
      ],
      examples: ['pai lessons add --title "Run tsc first" --kind workflow --applies-when "before committing"'],
      run: (ctx) => {
        const { title, kind } = ctx.opts;
        const when = ctx.opts["applies-when"];
        if (!title || !kind || !when) throw new CliError("--title, --kind and --applies-when are required");
        const l = wrap(() => addLesson({
          title: String(title), kind: kind as LessonKind, applies_when: String(when),
          project: ctx.opts.project as string | undefined, body: ctx.opts.body as string | undefined,
        }));
        console.log(`added ${l.id} [candidate]`);
        return 0;
      },
    },
    transition("approve", "approved", "Approve a candidate"),
    transition("reject", "rejected", "Reject a candidate"),
    {
      name: "promote",
      summary: "Promote an approved lesson to a project skill",
      description: "Writes the lesson as a SKILL.md under <project>/.claude/skills/<slug>/ (and with --agents also <project>/.agents/skills/<slug>/). Refuses to overwrite an existing skill unless --force.",
      args: [ID],
      options: [
        { name: "project", type: "string", value: "DIR", summary: "Project directory (default: this directory)" },
        { name: "force", type: "boolean", summary: "Overwrite an existing SKILL.md" },
        { name: "agents", type: "boolean", summary: "Also write under .agents/skills" },
      ],
      examples: ["pai lessons promote my-lesson --project ~/code/app --agents"],
      run: (ctx) => {
        const paths = wrap(() => promoteLesson(ctx.args.ID as string, {
          projectDir: (ctx.opts.project as string | undefined) ?? process.cwd(),
          force: ctx.opts.force === true,
          agentsDir: ctx.opts.agents === true,
        }));
        for (const p of paths) console.log(`promoted ${p}`);
        return 0;
      },
    },
    {
      name: "supersede",
      summary: "Replace an approved lesson by another approved one",
      description: "Marks ID superseded; the replacement given with --by must exist and be approved.",
      args: [ID],
      options: [{ name: "by", type: "string", value: "ID2", summary: "The approved lesson that replaces it" }],
      examples: ["pai lessons supersede old-lesson --by new-lesson"],
      run: (ctx) => {
        const by = ctx.opts.by as string | undefined;
        if (!by) throw new CliError("--by is required");
        const l = wrap(() => setState(ctx.args.ID as string, "superseded", { supersededBy: by }));
        console.log(`${l.id}: superseded by ${by}`);
        return 0;
      },
    },
    {
      name: "propose",
      summary: "Add candidates from a transcript",
      description: "Finds user messages that correct the assistant and adds each as a candidate to review. By default a regex heuristic (no model call); with --draft a model reads the user messages and drafts titled lessons with an applies-when and the quoted evidence (at most 10).",
      args: [{ name: "TRANSCRIPT", summary: "Transcript file (default: newest of this directory)" }],
      options: [
        { name: "draft", type: "boolean", summary: "Draft candidates with a model (running local model, else the routed default) instead of the regex heuristic" },
        { name: "local-only", type: "boolean", summary: "With --draft: fail rather than fall back to the cloud model when no local model is running" },
      ],
      examples: ["pai lessons propose", "pai lessons propose ./session.jsonl", "pai lessons propose --draft --dry-run"],
      run: async (ctx) => {
        const path = (ctx.args.TRANSCRIPT as string | undefined) ?? newestTranscriptOfCwd();
        if (!path) throw new CliError("no transcript found for this directory");
        const dry = ctx.dryRun;
        const found = ctx.opts.draft === true ? await draftFromTranscript(path, { localOnly: ctx.opts["local-only"] === true }).catch((e) => { throw new CliError(e instanceof Error ? e.message : String(e)); }) : wrap(() => proposeFromTranscript(path));
        if (found.length === 0) console.log("No corrections found.");
        if (dry) {
          for (const l of found) console.log(`would add [${l.kind}]  ${l.title}\n  applies when: ${l.applies_when || "(not set)"}\n  ${l.body}\n  evidence: ${(l.evidence ?? []).join(" | ")}`);
          return 0;
        }
        for (const l of wrap(() => found.map(addLesson))) console.log(`added ${l.id} [candidate]  ${l.title}`);
        return 0;
      },
    },
  ],
};
