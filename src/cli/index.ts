#!/usr/bin/env node
/**
 * PAI Knowledge OS — CLI entry point.
 *
 * Thin entry: builds the Commander program (see ./program.ts) and parses argv.
 * All command construction lives in buildProgram() so the docs generator can
 * introspect the same tree that powers `--help`.
 *
 * Daily surface:
 *   pai                    → deduped session listing (one row per name)
 *   pai <name>             → universal: switch live tab / resume / fresh
 *   pai <uuid-prefix>      → direct session resume via filesystem scan
 *   pai pause [all]        → save state (or mass-pause every live session)
 *   pai end                → finalize session
 *   pai help [area]        → rich man page for a command area
 */

import { CommanderError } from "commander";
import { buildProgram } from "./program.js";
import { err } from "./utils.js";
import { drainStdio } from "./lib/exit.js";

// `parse()` does not await async command actions — Commander fires the
// action and returns immediately, leaving its promise unawaited. When that
// promise later rejects (e.g. a Todoist call inside `task done`/`task add`
// throws), it becomes an unhandled rejection racing the process's natural
// exit: depending on timing, Node either prints the trace and exits 1, or —
// when nothing else is keeping the event loop alive — wins the race and
// exits 0 first, silently swallowing both the error and any output the
// action had queued. `parseAsync` makes `.parse` wait for the action, which
// turns that race into a deterministic await: any rejection is caught here
// and reported instead of disappearing.
await buildProgram()
  .parseAsync(process.argv)
  .catch((e) => {
    if (e instanceof CommanderError) {
      // program.ts's exitOverride() throws instead of calling process.exit()
      // so this catch is reached for --help, --version, and usage errors
      // too. Commander already wrote the help text or the formatted error
      // message itself (via outputHelp / configureOutput's writeErr) — just
      // adopt its exit code and let the process end naturally. A natural
      // exit flushes stdout/stderr even when either is a pipe; calling
      // process.exit() here would risk truncating output that's still
      // in-flight, same as the bug this replaces.
      process.exitCode = e.exitCode;
      return;
    }
    console.error(err(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  });

// Belt-and-suspenders: explicitly wait for stdout/stderr to drain before this
// module finishes and Node is free to decide the process is done. Avoiding
// process.exit() everywhere (see lib/exit.ts) means every command path
// relies on the event loop staying "non-empty" until a pending pipe write
// completes — true by default, but not something to leave unverified when a
// dependency's socket/timer/handle could in principle unref itself and let
// Node consider the loop empty a tick early. This makes the wait explicit
// and covers every command, not just the error/help paths above.
await drainStdio();
