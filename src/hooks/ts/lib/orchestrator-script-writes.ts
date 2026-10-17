/**
 * orchestrator-script-writes.ts — detect when an orchestrator worker runs a script
 * that writes to repo code files.
 *
 * Pure: no filesystem, no process.env read of its own. The hook entry
 * (pre-tool-use/orchestrator-script-writes.ts) resolves paths and checks the
 * filesystem/env, then hands this module the already-computed facts to
 * decide on — same split as lib/agent-gate.ts.
 */

// WRITE call regexes (any): /open\s*\([^)]*['"][wax]\+?b?['"]/ (python/perl-ish open with a write mode),
// /\.write_text\s*\(/, /\.write_bytes\s*\(/, /writeFileSync|appendFileSync|writeFile\s*\(|appendFile\s*\(|createWriteStream/,
// /File\.(write|open\([^)]*['"]w)/, /open\s*\(\s*(?:my\s+)?\$?\w*\s*,\s*['"]>>?/ (perl),
// /shutil\.(copy|move|copyfile)/, /os\.(rename|replace)\s*\(/ .
const WRITE_CALLS = [
  /open\s*\([^)]*['"][wax]\+?b?['"]/,
  /\.write_text\s*\(/,
  /\.write_bytes\s*\(/,
  /writeFileSync|appendFileSync|writeFile\s*\(|appendFile\s*\(|createWriteStream/,
  /File\.(write|open\([^)]*['"]w)/,
  /open\s*\(\s*(?:my\s+)?\$?\w*\s*,\s*['"]>>?/,
  /shutil\.(copy|move|copyfile)/,
  /os\.(rename|replace)\s*\(/,
];

/**
 * True when some segment (after skipping leading env assignments `X=y` and words
 * nohup/time/env/sudo) runs `python`, `python3`, `node`, `ruby` or `perl` and
 * either:
 *  (A) inline code (the word after -c for python, after -e / --eval / -p for node,
 *      -e for ruby/perl; for perl also -pi/-i flags with -e) contains a WRITE call
 *      AND is not exempt; or
 *  (B) the first positional argument is a script file path starting with `/tmp/` or
 *      `/private/tmp/` and readFile(path) (default: readFileSync utf8, null on error)
 *      returns text that contains a WRITE call AND mentions a repo source path,
 *      i.e. a quoted string containing one of `src/`, `scripts/`, `test/`, `packages/`,
 *      or ending in `.ts`/`.tsx`/`.js`/`.mjs`/`.json`.
 */
export function scriptWritesRepoCode(
  command: string,
  readFile: (path: string) => string | null = (path) => {
    try {
      return require('fs').readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }
): boolean {
  // Parse the command into segments
  const segments = parseCommand(command);

  for (const segment of segments) {
    const words = stripPrefix(segment.words);
    if (words.length === 0) continue;

    const [cmd, ...args] = words;

    // Only consider commands that run interpreters
    if (!['python', 'python3', 'node', 'ruby', 'perl'].includes(cmd)) continue;

    // Check for inline code execution
    const inlineCode = getInlineCode(cmd, args);
    if (inlineCode !== null) {
      // Check if this is a write call and if it's exempt
      const hasWriteCall = WRITE_CALLS.some(regex => regex.test(inlineCode));
      if (hasWriteCall && !isExempt(inlineCode, readFile)) {
        return true;
      }
      continue;
    }

    // Check for script file paths
    const scriptFile = getScriptFile(cmd, args);
    if (scriptFile && (scriptFile.startsWith('/tmp/') || scriptFile.startsWith('/private/tmp/'))) {
      const scriptContent = readFile(scriptFile);
      if (scriptContent !== null) {
        // Check if the script contains a write call to a repo path
        if (hasWriteCallToRepoPath(scriptContent)) {
          return true;
        }
      }
    }
  }

  return false;
}
  // Parse the command into segments
  const segments = parseCommand(command);

  for (const segment of segments) {
    const words = stripPrefix(segment.words);
    if (words.length === 0) continue;

    const [cmd, ...args] = words;

    // Only consider commands that run interpreters
    if (!['python', 'python3', 'node', 'ruby', 'perl'].includes(cmd)) continue;

    // Check for inline code execution
    const inlineCode = getInlineCode(cmd, args);
    if (inlineCode !== null) {
      // Check if this is a write call and if it's exempt
      const hasWriteCall = WRITE_CALLS.some(regex => regex.test(inlineCode));
      if (hasWriteCall && !isExempt(inlineCode, readFile)) {
        return true;
      }
      continue;
    }

    // Check for script file paths
    const scriptFile = getScriptFile(cmd, args);
    if (scriptFile && (scriptFile.startsWith('/tmp/') || scriptFile.startsWith('/private/tmp/'))) {
      const scriptContent = readFile(scriptFile);
      if (scriptContent !== null) {
        // Check if the script contains a write call to a repo path
        if (hasWriteCallToRepoPath(scriptContent)) {
          return true;
        }
      }
    }
  }

  return false;
}

// Helper function to parse command segments
function parseCommand(command: string): { words: string[]; redirects: string[] }[] {
  const segs: { words: string[]; redirects: string[] }[] = [];
  let seg: { words: string[]; redirects: string[] } = { words: [], redirects: [] };
  let tok = "";
  let has = false;
  let quote: string | null = null;
  let target: "redir" | "skip" | null = null;

  const flushTok = (): void => {
    if (!has) return;
    if (target === "redir") seg.redirects.push(tok);
    else if (target !== "skip") seg.words.push(tok);
    target = null;
    tok = "";
    has = false;
  };
  const endSeg = (): void => {
    flushTok();
    if (seg.words.length || seg.redirects.length) segs.push(seg);
    seg = { words: [], redirects: [] };
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) tok += command[++i];
      else tok += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      tok += command[++i];
      has = true;
    } else if (/\s/.test(ch) && ch !== "\n") {
      flushTok();
    } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if (ch === "&" && command[i + 1] === ">") continue;
      endSeg();
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    } else if (ch === ">" || ch === "<") {
      if (has && /^\d+$/.test(tok)) {
        tok = "";
        has = false;
      } else flushTok();
      if (ch === ">" && command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        i++;
        target = "skip";
      } else target = ch === ">" ? "redir" : "skip";
    } else {
      tok += ch;
      has = true;
    }
  }
  endSeg();
  return segs;
}

// Helper function to strip prefix from words
function stripPrefix(words: string[]): string[] {
  const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "exec", "builtin"]);
  const CONTROL_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "xargs"]);

  const out = [...words];
  while (out.length) {
    const w = out[0];
    if (/^[A-Za-z_]\w*=/.test(w) || WRAPPERS.has(w) || CONTROL_WORDS.has(w) || w === "") {
      const wasXargs = w === "xargs";
      out.shift();
      if (wasXargs) {
        while (out.length && isFlag(out[0])) {
          const f = out.shift()!;
          if (/^-[IiLnPsEd]$/.test(f)) out.shift();
        }
      }
      continue;
    }
    break;
  }
  return out;
}

// Helper function to check if a word is a flag
function isFlag(w: string): boolean {
  return w.startsWith("-") && w.length > 1;
}

// Helper function to extract inline code from command arguments
function getInlineCode(cmd: string, args: string[]): string | null {
  let code: string | null = null;

  if (cmd === 'python' || cmd === 'python3') {
    const cIndex = args.indexOf('-c');
    if (cIndex !== -1 && cIndex + 1 < args.length) {
      code = args[cIndex + 1];
    }
  } else if (cmd === 'node') {
    const eIndex = args.indexOf('-e');
    const evalIndex = args.indexOf('--eval');
    const pIndex = args.indexOf('-p');

    if (eIndex !== -1 && eIndex + 1 < args.length) {
      code = args[eIndex + 1];
    } else if (evalIndex !== -1 && evalIndex + 1 < args.length) {
      code = args[evalIndex + 1];
    } else if (pIndex !== -1 && pIndex + 1 < args.length) {
      code = args[pIndex + 1];
    }
  } else if (cmd === 'ruby') {
    const eIndex = args.indexOf('-e');
    if (eIndex !== -1 && eIndex + 1 < args.length) {
      code = args[eIndex + 1];
    }
  } else if (cmd === 'perl') {
    // Check for -e flag for perl
    const eIndex = args.indexOf('-e');
    if (eIndex !== -1 && eIndex + 1 < args.length) {
      code = args[eIndex + 1];
    }
    // Check for -pi or -i flags with -e (which is also considered inline code)
    const hasPiOrI = args.some(arg => /^-pi?$/i.test(arg));
    if (hasPiOrI && eIndex !== -1 && eIndex + 1 < args.length) {
      code = args[eIndex + 1];
    }
  }

  return code;
}

// Helper function to extract script file path from command arguments
function getScriptFile(cmd: string, args: string[]): string | null {
  // Skip the first word (which is the command itself) and check the rest
  // For python, ruby, perl, the script file is typically the first positional arg
  // For node, it's usually the first non-flag arg after the command
  const pos = args.filter((a) => !isFlag(a));

  if (cmd === 'python' || cmd === 'python3' || cmd === 'ruby' || cmd === 'perl') {
    return pos[0] || null;
  } else if (cmd === 'node') {
    // Node can have various flags, but the script file is the first non-flag argument
    // We need to skip any flags that are passed to node itself
    for (let i = 0; i < args.length; i++) {
      if (!isFlag(args[i])) {
        return args[i] || null;
      }
    }
    return null;
  }

  return null;
}

// Helper function to check if code is exempt from write call checks
function isExempt(code: string, readFile: (path: string) => string | null): boolean {
  // Remove quoted strings that start with exempt prefixes
  const exemptPrefixes = [
    '/tmp/',
    '/private/tmp/',
    '.pai-scratch/',
    'Notes/',
    '/dev/null',
    '/dev/stderr'
  ];

  // Extract all quoted strings from the code
  const quotedStrings = code.match(/(['"`])(?:(?=(\\?))\2.)*?\1/g) || [];

  // If there are no quoted strings at all, it's not exempt
  if (quotedStrings.length === 0) {
    return false;
  }

  // Check if all quoted strings are exempt
  const allExempt = quotedStrings.every(str => {
    // Remove quotes
    const path = str.slice(1, -1);
    return exemptPrefixes.some(prefix => path.startsWith(prefix));
  });

  // If all quoted strings are exempt, check if the code still contains write calls
  // If it does, then it's not exempt (because we want to exclude the exempted paths)
  if (allExempt) {
    // Check if code still contains write calls after removing exempted paths
    const codeWithoutExempt = code.replace(/(['"`])(?:(?=(\\?))\2.)*?\1/g, (match) => {
      const path = match.slice(1, -1);
      if (exemptPrefixes.some(prefix => path.startsWith(prefix))) {
        return '""'; // Replace with empty string to avoid matching
      }
      return match;
    });

    // Check if the modified code still contains write calls
    const hasWriteCall = WRITE_CALLS.some(regex => regex.test(codeWithoutExempt));
    return !hasWriteCall;
  }

  return false;
}

// Helper function to check if script content has write calls to repo paths
function hasWriteCallToRepoPath(content: string): boolean {
  // Check if content contains write calls
  const hasWriteCall = WRITE_CALLS.some(regex => regex.test(content));
  if (!hasWriteCall) return false;

  // Find quoted strings in the content
  const quotedStrings = content.match(/(['"`])(?:(?=(\\?))\2.)*?\1/g) || [];

  // Check if any quoted strings contain repo paths
  const repoPatterns = [
    /src\//,
    /scripts\//,
    /test\//,
    /packages\//,
    /\.(?:ts|tsx|js|mjs|json)$/
  ];

  for (const str of quotedStrings) {
    const path = str.slice(1, -1);
    for (const pattern of repoPatterns) {
      if (pattern.test(path)) {
        return true;
      }
    }
  }

  return false;
}