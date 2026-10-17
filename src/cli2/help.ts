/**
 * Help rendering and "did you mean" — the whole help experience in one file.
 *
 * Everything shown by `pai`, `pai help <command>`, `pai <command> --help`
 * and written by `pai doc` is derived from the CommandDef objects, so the
 * text next to a command's definition is the only copy.
 *
 * Colour only when stdout is a TTY and NO_COLOR is unset (FORCE_COLOR wins);
 * piped output is plain text.
 */

import { Chalk } from "chalk";
import type { CommandDef, GroupDef, OptDef } from "./define.js";

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

export interface Style {
  color: boolean;
  bold(s: string): string;
  dim(s: string): string;
  cyan(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  head(s: string): string;
}

export function colorEnabled(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  return isTTY && env.TERM !== "dumb";
}

export function makeStyle(color: boolean): Style {
  const c = new Chalk({ level: color ? 1 : 0 });
  return {
    color,
    bold: (s) => c.bold(s),
    dim: (s) => c.dim(s),
    cyan: (s) => c.cyan(s),
    green: (s) => c.green(s),
    yellow: (s) => c.yellow(s),
    red: (s) => c.red(s),
    head: (s) => c.bold.underline(s),
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, "").length;
const padEnd = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s)));

/** Aligned table with a header row. Cells may carry colour; widths ignore it. */
export function renderTable(headers: string[], rows: string[][], st: Style, indent = "  "): string {
  const widths = headers.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ""))));
  const line = (cells: string[]) =>
    indent + cells.map((c, i) => (i === cells.length - 1 ? c : padEnd(c, widths[i]))).join("  ").trimEnd();
  return [
    line(headers.map((h) => st.dim(h))),
    indent + st.dim(widths.map((w) => "─".repeat(w)).join("  ")),
    ...rows.map(line),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Did you mean
// ---------------------------------------------------------------------------

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Closest candidate to `input`, or null when nothing is plausibly meant. */
export function suggest(input: string, candidates: string[]): string | null {
  const x = input.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const lc = c.toLowerCase();
    let d = distance(x, lc);
    if (x.length >= 2 && (lc.startsWith(x) || x.startsWith(lc))) d = Math.min(d, 1);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  const limit = Math.max(1, Math.floor(x.length / 3) + (x.length > 4 ? 1 : 0));
  return best !== null && bestScore <= limit ? best : null;
}

// ---------------------------------------------------------------------------
// Command help
// ---------------------------------------------------------------------------

const flagText = (o: OptDef) =>
  `${o.short ? `-${o.short}, ` : "    "}--${o.name}${o.type !== "boolean" ? ` ${o.value ?? o.type.toUpperCase()}` : ""}`;

export function usageLine(path: string[], cmd: CommandDef): string {
  const parts = ["pai", ...path];
  if (cmd.subcommands?.length && !cmd.run) parts.push("<command>");
  for (const a of cmd.args ?? []) {
    const n = a.variadic ? `${a.name}...` : a.name;
    parts.push(a.required ? n : `[${n}]`);
  }
  if (cmd.subcommands?.length && cmd.run) parts.push("[command]");
  if (cmd.options?.length) parts.push("[options]");
  return parts.join(" ");
}

function defaultText(o: OptDef): string {
  if (o.default === undefined || o.default === false) return "—";
  return String(o.default);
}

/** Full help for one command (what `pai help <cmd>` and `pai <cmd> --help` print). */
export function renderCommandHelp(path: string[], cmd: CommandDef, st: Style): string {
  const out: string[] = [];
  out.push(`${st.head("Usage")}  ${st.bold(usageLine(path, cmd))}`, "");
  out.push(cmd.description.trim(), "");
  if (cmd.aliasOf) out.push(st.dim(`Shortcut for: pai ${cmd.aliasOf}`), "");
  if (cmd.later) out.push(st.yellow(`Not ported yet — still the old command: pai ${cmd.later}`), "");

  if (cmd.subcommands?.length) {
    out.push(st.head("Commands"));
    out.push(
      renderTable(
        ["Command", "Description"],
        cmd.subcommands.filter((s) => !s.later).map((s) => [st.cyan(s.name), s.summary]),
        st
      )
    );
    const later = cmd.subcommands.filter((s) => s.later);
    if (later.length) out.push(st.dim(`  also (not ported yet): ${later.map((s) => s.name).join(", ")}`));
    out.push("");
  }
  if (cmd.args?.length) {
    out.push(st.head("Arguments"));
    out.push(
      renderTable(
        ["Argument", "Required", "Description"],
        cmd.args.map((a) => [st.cyan(a.variadic ? `${a.name}...` : a.name), a.required ? "yes" : "no", a.summary]),
        st
      ),
      ""
    );
  }
  const opts: OptDef[] = [
    ...(cmd.options ?? []),
    { name: "help", short: "h", type: "boolean", summary: "Show this help" },
  ];
  out.push(st.head("Options"));
  out.push(
    renderTable(
      ["Flag", "Type", "Default", "Description"],
      opts.map((o) => [st.cyan(flagText(o)), o.type === "boolean" ? "flag" : o.type, defaultText(o), o.summary]),
      st
    ),
    ""
  );
  if (cmd.examples.length) {
    out.push(st.head("Examples"));
    for (const e of cmd.examples) out.push(`  ${st.green("$")} ${e}`);
    out.push("");
  }
  if (cmd.seeAlso?.length) out.push(`${st.head("See also")}  ${cmd.seeAlso.join(", ")}`, "");
  return out.join("\n").replace(/\n+$/, "\n");
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const DAILY_EXAMPLES = [
  ["pai ls", "what sessions do I have?"],
  ["pai open my-session", "continue it, on the provider it used"],
  ["pai open my-session --provider kimi", "continue it on another provider"],
  ["pai new --provider glm", "fresh session here on glm"],
  ["pai providers use glm", "make glm the default"],
];

function commandRows(cmds: CommandDef[], st: Style): string[][] {
  return cmds.map((c) => [st.cyan(c.name), c.summary]);
}

/** `pai` with no arguments: daily commands only, grouped, with examples. */
export function renderOverview(groups: GroupDef[], version: string, st: Style): string {
  const out: string[] = [];
  out.push(`${st.bold("pai")} ${st.dim(version)} — sessions and providers for Claude Code`, "");
  out.push(`${st.head("Usage")}  ${st.bold("pai <command> [options]")}`, "");
  for (const g of groups.filter((x) => x.daily && x.commands.some((c) => !c.later))) {
    out.push(st.head(g.title));
    out.push(renderList(commandRows(g.commands.filter((c) => !c.later), st), st), "");
  }
  out.push(st.head("Examples"));
  for (const [cmd, why] of DAILY_EXAMPLES) out.push(`  ${st.green("$")} ${cmd.padEnd(40)} ${st.dim(why)}`);
  out.push("");
  out.push(
    st.dim(`More: ${groups.filter((g) => !g.daily).map((g) => g.title).join(", ")} — pai help more`),
    st.dim("Details for one command: pai help <command>   (same as pai <command> --help)"),
    ""
  );
  return out.join("\n");
}

/** `pai help more`: everything that is not a daily command. */
export function renderMore(groups: GroupDef[], st: Style): string {
  const out: string[] = [st.head("More commands"), ""];
  for (const g of groups.filter((x) => !x.daily)) {
    out.push(st.bold(g.title));
    out.push(
      renderTable(
        ["Command", "Description", "Status"],
        g.commands.map((c) => [st.cyan(c.name), c.summary, c.later ? st.yellow("old pai only") : st.green("ready")]),
        st
      ),
      ""
    );
  }
  out.push(st.dim("Details for one command: pai help <command>"), "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown reference (pai doc)
// ---------------------------------------------------------------------------

function mdCommand(path: string[], cmd: CommandDef, level: number): string[] {
  const h = "#".repeat(level);
  const out = [`${h} pai ${path.join(" ")}`, "", cmd.summary, "", "```", usageLine(path, cmd), "```", "", cmd.description.trim(), ""];
  if (cmd.aliasOf) out.push(`Shortcut for \`pai ${cmd.aliasOf}\`.`, "");
  if (cmd.later) out.push(`_Not ported yet — still the old command \`pai ${cmd.later}\`._`, "");
  if (cmd.args?.length) {
    out.push("| Argument | Required | Description |", "|---|---|---|");
    for (const a of cmd.args) out.push(`| \`${a.variadic ? `${a.name}...` : a.name}\` | ${a.required ? "yes" : "no"} | ${a.summary} |`);
    out.push("");
  }
  if (cmd.options?.length) {
    out.push("| Flag | Type | Default | Description |", "|---|---|---|---|");
    for (const o of cmd.options) {
      out.push(`| \`${flagText(o).trim()}\` | ${o.type === "boolean" ? "flag" : o.type} | ${defaultText(o)} | ${o.summary} |`);
    }
    out.push("");
  }
  if (cmd.examples.length) out.push("```sh", ...cmd.examples, "```", "");
  if (cmd.seeAlso?.length) out.push(`See also: ${cmd.seeAlso.map((s) => `\`${s}\``).join(", ")}`, "");
  for (const s of cmd.subcommands ?? []) out.push(...mdCommand([...path, s.name], s, level + 1));
  return out;
}

export function renderMarkdown(groups: GroupDef[], version: string): string {
  const out = [`# pai ${version} — command reference`, "", "_Generated by `pai doc` from the command definitions. Do not edit by hand._", ""];
  for (const g of groups) {
    out.push(`## ${g.title}`, "");
    for (const c of g.commands) out.push(...mdCommand([c.name], c, 3));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Two-column list without a header row — the overview and `help more` use it. */
function renderList(rows: string[][], st: Style, indent = "  "): string {
  const w = Math.max(...rows.map((r) => visible(r[0])));
  return rows.map((r) => `${indent}${padEnd(r[0], w)}  ${r.slice(1).join("  ")}`.trimEnd()).join("\n");
}
