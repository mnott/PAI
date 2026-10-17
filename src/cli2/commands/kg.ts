/** `pai kg ...`: the knowledge graph of facts extracted from notes. */

import type { Command } from "commander";
import { OPT, type CommandDef, type OptDef } from "../define.js";
import { bridged } from "../lib/bridge.js";
import { registerKgCommands } from "../lib/kg.js";

const project: OptDef = { ...OPT.project, value: "SLUG", summary: "Only this project" };
const k = (path: string[], def: Omit<CommandDef, "run">) => bridged(registerKgCommands, "kg", path, def);

export const kgCommand: CommandDef = {
  name: "kg",
  summary: "Facts extracted from your notes, with the time they were true",
  description:
    "The knowledge graph stores facts as subject - predicate - object triples, each with the time span it was valid. " +
    "Use it to ask what was true at a given date, or what changed.",
  examples: ["pai kg stats", "pai kg list --limit 10", "pai kg query --subject PAI"],
  seeAlso: ["pai memory search", "pai zettel"],
  subcommands: [
    k(["backfill"], {
      name: "backfill",
      summary: "Extract facts from existing session notes",
      description: "Reads session notes that have not been processed yet and adds their facts to the graph. Safe to run again; finished notes are skipped.",
      options: [
        project,
        { name: "limit", type: "number", value: "N", summary: "Process at most this many notes" },
        { ...OPT.dryRun, summary: "List the notes that would be processed; extract nothing" },
      ],
      examples: ["pai kg backfill --dry-run", "pai kg backfill --project my-project --limit 20"],
      seeAlso: ["pai kg stats"],
    }),
    k(["query"], {
      name: "query",
      summary: "Look up facts by subject, predicate, object or date",
      description: "Prints the facts that match every filter you give. With --as-of it shows what was true on that date.",
      options: [
        { name: "subject", type: "string", value: "TEXT", summary: "Only facts about this subject" },
        { name: "predicate", type: "string", value: "TEXT", summary: "Only this kind of relation" },
        { name: "object", type: "string", value: "TEXT", summary: "Only facts with this object" },
        { name: "as-of", type: "string", value: "DATE", summary: "What was true then (YYYY-MM-DD or ISO 8601)" },
        project,
        { ...OPT.json, summary: "Output raw JSON" },
      ],
      examples: ["pai kg query --subject PAI", "pai kg query --subject PAI --as-of 2026-01-01 --json"],
      seeAlso: ["pai kg list"],
    }),
    k(["list"], {
      name: "list",
      summary: "List the facts that are true now",
      description: "Prints currently valid facts, newest first.",
      options: [project, { name: "limit", type: "number", value: "N", default: 50, summary: "Maximum facts to print" }],
      examples: ["pai kg list", "pai kg list --project my-project --limit 10"],
      seeAlso: ["pai kg query"],
    }),
    k(["stats"], {
      name: "stats",
      summary: "How many facts and contradictions the graph holds",
      description: "Prints counts of facts and of facts that contradict each other.",
      examples: ["pai kg stats", "pai kg list --limit 5"],
      seeAlso: ["pai kg list"],
    }),
  ],
};
