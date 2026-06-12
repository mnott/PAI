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

import { buildProgram } from "./program.js";

buildProgram().parse(process.argv);
