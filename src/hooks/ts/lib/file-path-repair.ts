/**
 * file-path-repair.ts — a worker's Read/Edit/Write file_path that does not
 * exist is repaired before the call or denied with the closest tracked files.
 *
 * Measured causes of "File does not exist": markup fused into the path by the
 * model server (`…/x.ts </parameter> <offset> 638 …`), absolute paths into
 * another tree (main checkout, an old worktree) and relative or guessed names.
 * Rules, first hit wins: markup tail, other tree, relative, unique basename,
 * else deny. Write may create a file, so it only gets markup and other-tree
 * fixes and is never denied. Relocating rules never leave cwd.
 *
 * Pure apart from the injected `fs` seam; the hook does the I/O.
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renderDecision } from "./render-decision.js";
import type { ToolNameRepairInput } from "./tool-name-repair.js";

export interface PathRepairCtx {
  cwd: string;
  exists?: (p: string) => boolean;
  /** git ls-files of cwd, relative paths. */
  tracked: () => string[];
  /** Root of the main checkout, when known. */
  mainRoot?: () => string | null;
}

export type PathRepairResult =
  | { kind: "repair"; rule: string; from: string; to: string; updatedInput: Record<string, unknown> }
  | { kind: "deny"; reason: string };

const PATH_TOOLS = new Set(["Read", "Edit", "Write"]);
const MARKUP = /<\/parameter>|<parameter|<offset>|<limit>|\r?\n/;
const TREE_PREFIX = /^.*\/(?:worktrees|workters)\/[^/]+\//;

function inside(cwd: string, p: string): boolean {
  const rel = relative(cwd, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function closestTracked(path: string, tracked: string[], n = 5): string[] {
  const want = basename(path).toLowerCase();
  return tracked
    .map((f) => ({ f, d: editDistance(want, basename(f).toLowerCase()) }))
    .sort((x, y) => x.d - y.d || x.f.length - y.f.length)
    .slice(0, n)
    .map((x) => x.f);
}

/** The one resolution function: the first existing candidate under cwd for a path, with the rule that found it. */
function resolvePath(raw: string, ctx: PathRepairCtx, mayCreate: boolean): { rule: string; to: string } | null {
  const ex = ctx.exists ?? existsSync;
  const { cwd } = ctx;
  const under = (rule: string, p: string, needExist = true) =>
    inside(cwd, p) && (!needExist || ex(p)) ? { rule, to: p } : null;

  let ownTree = !isAbsolute(raw);
  if (!isAbsolute(raw)) {
    const hit = under("relative", resolve(cwd, raw));
    if (hit) return hit;
  } else {
    const wt = TREE_PREFIX.exec(raw);
    if (wt) {
      ownTree = true;
      const hit = under("other-tree", join(cwd, raw.slice(wt[0].length)), !mayCreate);
      if (hit) return hit;
    }
    const root = ctx.mainRoot?.();
    if (inside(cwd, raw)) ownTree = true;
    if (root && raw.startsWith(root + sep)) {
      ownTree = true;
      const hit = under("other-tree", join(cwd, raw.slice(root.length + 1)), !mayCreate);
      if (hit) return hit;
    }
    const parts = raw.split(sep).filter(Boolean);
    // dir/file at least: a bare basename would map an unrelated path onto a same-named repo file
    for (let i = 0; i < parts.length - 1; i++) {
      const hit = under("other-tree", join(cwd, ...parts.slice(i)));
      if (hit) return hit;
    }
  }
  if (mayCreate || !ownTree) return null;
  const base = basename(raw);
  const same = ctx.tracked().filter((f) => basename(f) === base);
  return same.length === 1 ? { rule: "basename", to: join(cwd, same[0]) } : null;
}

export function repairFilePath(
  input: ToolNameRepairInput,
  env: NodeJS.ProcessEnv,
  ctx: PathRepairCtx,
): PathRepairResult | null {
  if (env.PAI_WORKER !== "1") return null;
  const tool = input.tool_name ?? "";
  if (!PATH_TOOLS.has(tool)) return null;
  const ti = input.tool_input ?? {};
  const raw = ti.file_path;
  if (typeof raw !== "string" || raw === "") return null;
  const ex = ctx.exists ?? existsSync;
  const mayCreate = tool === "Write" || (tool === "Edit" && ti.old_string === "");
  if (!MARKUP.test(raw) && isAbsolute(raw) && ex(raw)) return null;

  const done = (rule: string, to: string, extra: Record<string, unknown> = {}): PathRepairResult => ({
    kind: "repair",
    rule,
    from: raw,
    to,
    updatedInput: { ...ti, ...extra, file_path: to },
  });

  const cut = raw.split(MARKUP)[0].trim();
  if (cut !== raw && cut !== "") {
    const extra: Record<string, unknown> = {};
    if (tool === "Read") {
      const tail = raw.slice(raw.indexOf(cut) + cut.length);
      const off = /<offset>\s*(\d+)/.exec(tail);
      const lim = /<limit>\s*(\d+)/.exec(tail);
      if (off && ti.offset === undefined) extra.offset = Number(off[1]);
      if (lim && ti.limit === undefined) extra.limit = Number(lim[1]);
    }
    if (ex(cut) || mayCreate) return done("markup", cut, extra);
    const hit = resolvePath(cut, ctx, mayCreate);
    if (hit) return done(`markup+${hit.rule}`, hit.to, extra);
  }

  const hit = resolvePath(cut || raw, ctx, mayCreate);
  if (hit) return done(hit.rule, hit.to);
  if (mayCreate) return null;

  const near = closestTracked(cut || raw, ctx.tracked());
  return {
    kind: "deny",
    reason:
      `does not exist: ${cut || raw}. Do not guess paths.` +
      (near.length ? ` Closest tracked files: ${near.join(", ")}.` : "") +
      " Use Glob to find it.",
  };
}

export function renderPathRepair(r: Extract<PathRepairResult, { kind: "repair" }>): string {
  const msg = `path repaired: ${r.from} → ${r.to} (${r.rule})`;
  return renderDecision({ decision: "allow", updatedInput: r.updatedInput, context: msg });
}

export function renderPathDeny(r: Extract<PathRepairResult, { kind: "deny" }>): string {
  return renderDecision({ decision: "deny", reason: r.reason });
}
