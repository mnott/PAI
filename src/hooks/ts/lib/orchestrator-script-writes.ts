/**
 * orchestrator-script-writes.ts — interpreter scripts that write repo code.
 * Orchestrator workers may not write code; python/node/ruby/perl one-liners and
 * /tmp scripts were a hole in the Bash guard. Pure but for the script reader.
 */

import { readFileSync } from "node:fs";
import { parseCommand } from "./worker-guard.js";

const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl"]);

const WRITE_CALLS: RegExp[] = [
  /open\s*\([^)]*['"][wax]\+?b?['"]/,
  /\.write_text\s*\(/,
  /\.write_bytes\s*\(/,
  /writeFileSync|appendFileSync|writeFile\s*\(|appendFile\s*\(|createWriteStream/,
  /File\.(?:write|open\([^)]*['"]w)/,
  /open\s*\(\s*(?:my\s+)?\$?\w*\s*,\s*['"]>>?/,
  /shutil\.(?:copy|move|copyfile)/,
  /os\.(?:rename|replace)\s*\(/,
];

const EXEMPT_PREFIXES = ["/tmp/", "/private/tmp/", ".pai-scratch/", "Notes/", "/dev/null", "/dev/stderr"];

const REPO_PATH = /['"][^'"]*(?:src\/|scripts\/|test\/|packages\/)[^'"]*['"]|['"][^'"]*\.(?:ts|tsx|js|mjs|json)['"]/;

const hasWriteCall = (code: string): boolean => WRITE_CALLS.some((re) => re.test(code));

/** Quoted string literals of the code that look like paths. */
function pathLiterals(code: string): string[] {
  return [...code.matchAll(/['"]([^'"\n]+)['"]/g)].map((m) => m[1]).filter((s) => s.includes("/") || /\.\w{1,5}$/.test(s));
}

/** Inline code writes outside the exempt areas (or names no path at all). */
function inlineWrites(code: string): boolean {
  if (!hasWriteCall(code)) return false;
  const paths = pathLiterals(code);
  if (paths.length === 0) return true;
  return !paths.every((p) => EXEMPT_PREFIXES.some((x) => p.startsWith(x)));
}

function inlineCode(cmd: string, args: string[]): string | null {
  const flags = cmd.startsWith("python") ? ["-c"] : cmd === "node" ? ["-e", "--eval", "-p"] : ["-e"];
  for (let i = 0; i < args.length - 1; i++) {
    if (flags.includes(args[i]) || (cmd === "perl" && /^-[a-z]*e$/.test(args[i]))) return args[i + 1];
  }
  return null;
}

const defaultReader = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** True when the command runs an interpreter whose code (inline, or a /tmp script) writes repo code. */
export function scriptWritesRepoCode(command: string, readFile: (path: string) => string | null = defaultReader): boolean {
  for (const seg of parseCommand(command)) {
    const words = [...seg.words];
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || ["nohup", "time", "env", "sudo"].includes(words[0]))) words.shift();
    const [cmd, ...args] = words;
    if (!cmd || !INTERPRETERS.has(cmd)) continue;
    const code = inlineCode(cmd, args);
    if (code !== null) {
      if (inlineWrites(code)) return true;
      continue;
    }
    const script = args.find((a) => !a.startsWith("-"));
    if (script && /^(?:\/private)?\/tmp\//.test(script)) {
      const text = readFile(script);
      if (text !== null && hasWriteCall(text) && REPO_PATH.test(text) && inlineWrites(text)) return true;
    }
  }
  return false;
}