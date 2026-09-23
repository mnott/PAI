/**
 * plutil-guard.ts — blocks plutil edit verbs (-extract, -replace, -insert,
 * -remove, -convert, -create) run without an explicit -o <path>.
 *
 * Without -o, plutil writes the result back into the source file instead of
 * printing it — `plutil -extract ProgramArguments json <plist>` run as a
 * read destroyed three LaunchAgent plists on 2026-09-23. -p, -lint, -help
 * and any edit verb that does carry -o are unaffected.
 *
 * Pure: scans the raw command string for each `plutil ...` invocation up to
 * the next hard shell separator (&& || ; | backtick paren newline), so it
 * catches compound lines, subshells, and loop bodies without a real parser.
 */

const EDIT_VERB = /-(extract|replace|insert|remove|convert|create)\b/;
const HAS_DASH_O = /(^|\s)-o(\s|$)/;
const INVOCATION = /\bplutil\b([^&|;`()\n]*)/g;

export interface PlutilGuardResult {
  blocked: boolean;
  invocation?: string;
  verb?: string;
}

export function detectUnsafePlutil(command: string): PlutilGuardResult {
  INVOCATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOCATION.exec(command))) {
    const args = m[1];
    const verbMatch = args.match(EDIT_VERB);
    if (!verbMatch) continue;
    if (HAS_DASH_O.test(args)) continue;
    return { blocked: true, invocation: `plutil${args}`.trim(), verb: `-${verbMatch[1]}` };
  }
  return { blocked: false };
}

export function plutilGuardMessage(verb: string): string {
  return (
    `plutil ${verb} without -o rewrites the file in place; ` +
    "read with `plutil -p <file>` or `plutil -extract <key> raw -o - <file>`"
  );
}
