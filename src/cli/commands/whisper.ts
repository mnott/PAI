/** whisper.ts — `pai whisper prune`: drop expired "UNTIL <time>" rule lines from whisper-rules.md. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CommandDef } from "../define.js";
import { whisperRulesPath } from "../../config/pai-files.js";
import { pruneExpired } from "../../hooks/ts/lib/whisper-expiry.js";

const pruneCommand: CommandDef = {
  name: "prune",
  summary: "Remove expired UNTIL rule lines from whisper-rules.md",
  description: "Rule lines starting with \"UNTIL YYYY-MM-DD HH:MM\" stop being injected at that time; this removes them from the file.",
  examples: ["pai whisper prune"],
  run: () => {
    const f = whisperRulesPath();
    if (!existsSync(f)) {
      process.stdout.write("no whisper-rules.md\n");
      return;
    }
    const r = pruneExpired(readFileSync(f, "utf-8"));
    if (r.removed > 0) writeFileSync(f, r.text);
    process.stdout.write(`pruned ${r.removed} expired rule line(s)\n`);
  },
};

export const whisperCommand: CommandDef = {
  name: "whisper",
  summary: "Whisper rule maintenance: prune",
  description: "Maintenance of ~/.pai/whisper-rules.md. A rule line starting with \"UNTIL YYYY-MM-DD HH:MM\" is injected only before that time.",
  examples: ["pai whisper prune"],
  subcommands: [pruneCommand],
  run: () => {
    process.stdout.write("usage: pai whisper prune\n");
  },
};
