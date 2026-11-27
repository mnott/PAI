/**
 * harvest.ts — after the moderator's closing post: write <board>/result.md (header, the closing
 * synthesis, each participant's last FINAL position) and tell the calling session where it is.
 * Best effort: a failed notification is reported on stderr and never fails the post.
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardDir, brainstormRoot, loadIndex, readPosts, type Post } from "./board.js";

export interface BrainstormMeta {
  id: string;
  goal: string;
  participants: number;
  lenses: string[];
  rounds: number;
  caller?: string;
  workers?: Record<string, string>;
  startedAt: string;
  maxMinutes?: number;
  context?: string[];
}

export function readMeta(id: string, root = brainstormRoot()): BrainstormMeta | null {
  try {
    return JSON.parse(readFileSync(join(boardDir(id, root), "meta.json"), "utf8")) as BrainstormMeta;
  } catch {
    return null;
  }
}

export type SendFn = (caller: string, text: string) => Promise<void>;

export const sendViaAibroker: SendFn = (caller, text) =>
  new Promise((resolve, reject) => {
    execFile("aibroker", ["send", caller, text], { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
  });

/** The closing post's text without the leading CLOSED word. */
export function synthesisOf(text: string): string {
  return text.replace(/^\s*CLOSED\b[:.\s-]*/, "").trim();
}

function finalPositions(posts: Post[]): string[] {
  const roles = [...new Set(posts.filter((p) => p.role !== "moderator").map((p) => p.role))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  return roles.map((r) => {
    const mine = posts.filter((p) => p.role === r);
    const fin = [...mine].reverse().find((p) => /^\s*FINAL:/i.test(p.text));
    const p = fin ?? mine[mine.length - 1];
    return `- **${r}** (#${p.n}${fin ? "" : ", no FINAL"}): ${p.text.replace(/^\s*FINAL:\s*/i, "").replace(/\n+/g, " ")}`;
  });
}

export interface HarvestResult {
  path: string;
  notified: boolean;
}

export async function harvest(id: string, deps: { send?: SendFn; root?: string } = {}): Promise<HarvestResult> {
  const root = deps.root ?? brainstormRoot();
  const idx = loadIndex(id, root);
  if (!idx) throw new Error(`no brainstorm board "${id}"`);
  const meta = readMeta(id, root);
  const posts = readPosts(id, 0, root);
  const closing = [...posts].reverse().find((p) => p.role === "moderator" && /^\s*CLOSED\b/.test(p.text));
  const synthesis = closing ? synthesisOf(closing.text) : "(no closing post)";
  const minutes = closing ? Math.max(0, Math.round((Date.parse(closing.at) - Date.parse(idx.createdAt)) / 60000)) : 0;
  const lines = [
    `# Brainstorm result ${id}`,
    "",
    `- Goal: ${idx.goal}`,
    `- Board: ${id}`,
    `- Participants: ${meta?.participants ?? new Set(posts.filter((p) => p.role !== "moderator").map((p) => p.role)).size}`,
    `- Rounds: ${meta?.rounds ?? "?"}`,
    `- Duration: ${minutes} min, ${posts.length} posts`,
    "",
    synthesis,
    "",
    "## Attached: final positions",
    "",
    ...finalPositions(posts),
    "",
  ];
  const path = join(boardDir(id, root), "result.md");
  writeFileSync(path, lines.join("\n"));

  let notified = false;
  const caller = meta?.caller;
  if (caller) {
    const nowList = synthesis.split("\n").slice(synthesis.split("\n").findIndex((l) => /^##\s*Now/i.test(l)) + 1).filter((l) => l.trim());
    const head = nowList.slice(0, 3).join(" | ").slice(0, 400);
    const text = `Brainstorm ${id} closed. Result: ${path}${head ? ` Now: ${head}` : ""}`;
    try {
      await (deps.send ?? sendViaAibroker)(caller, text);
      notified = true;
    } catch (e) {
      process.stderr.write(`brainstorm: could not notify ${caller}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return { path, notified };
}
