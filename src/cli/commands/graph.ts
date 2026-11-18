/** `pai graph ...`: relations between projects, notes and external documents. */

import { CliError, OPT, type CommandDef, type OptDef } from "../define.js";
import { getStorageBackend } from "../../storage/factory.js";
import { registeredProjects } from "../../codegraph/projects.js";
import { related, formatRelated, type Domain } from "../../codegraph/graph.js";

const json: OptDef = { ...OPT.json, summary: "Output raw JSON" };

export const graphCommand: CommandDef = {
  name: "graph",
  summary: "Relations across projects, notes and external documents",
  description:
    "Queries the relations that `pai code relate` derives (depends-on, calls-api, shares-protocol, duplicates, mentions, cites). " +
    "When an external graph source is configured (externalGraph in the main config) and reachable, its edges are joined in; otherwise the answer says it ran without them.",
  examples: ["pai graph related resolveRoot", "pai graph related src/codegraph/api.ts --depth 2 --domain code,note"],
  seeAlso: ["pai code relate", "pai code explore"],
  subcommands: [
    {
      name: "related",
      summary: "Neighbours of a key, path or symbol",
      description: "Lists what is related to a typed key (code:<project>:<path>#<symbol>, note:<vault>:<path>, caseleaf:..., cite:...), a file path, a symbol name or a project slug, grouped by relation, with file and line for code.",
      args: [{ name: "KEY", summary: "Typed key, file path, symbol name or project slug", required: true }],
      options: [
        { name: "depth", type: "number", value: "N", default: 1, summary: "Hops to follow (1-3)" },
        { name: "domain", type: "string", value: "LIST", summary: "Comma list of code, note, external" },
        json,
      ],
      examples: ["pai graph related my-app", "pai graph related code:my-app:src/index.ts#main --depth 2"],
      seeAlso: ["pai code relate"],
      run: async (ctx) => {
        const key = ctx.args.KEY as string | undefined;
        if (!key) throw new CliError("Missing key", "Run: pai graph --help");
        const domains = String(ctx.opts.domain ?? "").split(",").map((d) => d.trim()).filter((d): d is Domain => d === "code" || d === "note" || d === "external");
        const r = await related(await getStorageBackend(), await registeredProjects(), key, { depth: Number(ctx.opts.depth ?? 1), domains });
        console.log(ctx.opts.json === true ? JSON.stringify(r, null, 2) : formatRelated(r));
      },
    },
  ],
};
