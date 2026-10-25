/** `pai uhp serve|token`: PAI as a Unified Harness Protocol server (src/uhp-server). */

import { join } from "node:path";
import { isLoopbackHostname, LOOPBACK_HOST } from "../../utils/loopback.js";
import { CliError, type CommandDef, type RunContext } from "../define.js";
import { createToken, readTokens, revokeToken } from "../../uhp-server/auth.js";
import { createUhpServer, defaultStateDir } from "../../uhp-server/server.js";
import { renderTable, ok, warn } from "../lib/utils.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const tokensFile = (ctx: RunContext): string => str(ctx.opts.tokens) ?? join(defaultStateDir(), "tokens.json");

const tokensOpt = { name: "tokens", type: "string", value: "FILE", summary: "Tokens file (default: <PAI_HOME>/uhp/tokens.json)" } as const;

const serveCommand: CommandDef = {
  name: "serve",
  summary: "Serve PAI's workers over the Unified Harness Protocol",
  description:
    "Starts an HTTP server speaking UHP 2026-10-19 (core class): discovery, harnesses and models from the worker providers and classes, POST /v1/responses over `pai worker run` with SSE, sessions, cancel, bearer tokens, idempotency. Binds loopback by default; a non-loopback bind needs --allow-remote and at least one token, and TLS must come from a terminator in front.",
  options: [
    { name: "port", type: "number", value: "PORT", default: 8791, summary: "Port to listen on" },
    { name: "bind", type: "string", value: "HOST", default: LOOPBACK_HOST, summary: "Address to bind" },
    { name: "allow-remote", type: "boolean", summary: "Allow a non-loopback bind (needs tokens; put TLS in front)" },
    tokensOpt,
  ],
  examples: ["pai uhp token create laptop", "pai uhp serve", "pai uhp serve --port 8791 --tokens ./tokens.json"],
  seeAlso: ["pai uhp token", "pai worker run"],
  run: async (ctx) => {
    const host = str(ctx.opts.bind) ?? LOOPBACK_HOST;
    const port = typeof ctx.opts.port === "number" ? ctx.opts.port : 8791;
    const tokensPath = tokensFile(ctx);
    if (!isLoopbackHostname(host)) {
      if (!ctx.opts["allow-remote"]) throw new CliError(`refusing to bind ${host}: not loopback`, "add --allow-remote (and tokens, behind a TLS terminator)");
      if (!readTokens(tokensPath).some((t) => !t.revoked)) throw new CliError("refusing a remote bind without tokens", "pai uhp token create NAME");
      console.log(warn("TLS required: put a TLS terminator in front (UHP security §7)"));
    }
    const server = createUhpServer({ tokensPath });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    console.log(ok(`UHP server on http://${host}:${port}/v1/uhp (tokens: ${tokensPath})`));
    await new Promise<void>((resolve) => {
      for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => server.close(() => resolve()));
    });
  },
};

const tokenCommand: CommandDef = {
  name: "token",
  summary: "Create, list and revoke UHP bearer tokens",
  description: "Tokens are stored as sha256 hashes; the value is shown once on creation. Revocation takes effect on the next request.",
  examples: ["pai uhp token create laptop", "pai uhp token list", "pai uhp token revoke laptop"],
  subcommands: [
    {
      name: "create",
      summary: "Mint a token",
      description: "Prints the token once; it cannot be shown again.",
      args: [{ name: "NAME", required: true, summary: "Label for the token" }],
      options: [tokensOpt],
      examples: ["pai uhp token create laptop"],
      run: (ctx) => {
        const { token, record } = createToken(tokensFile(ctx), ctx.args.NAME as string);
        console.log(`${record.id}  ${token}`);
      },
    },
    {
      name: "list",
      summary: "List tokens (never their values)",
      description: "Shows id, name, creation time and whether the token is revoked.",
      options: [tokensOpt],
      examples: ["pai uhp token list"],
      run: (ctx) => {
        const rows = readTokens(tokensFile(ctx)).map((t) => [t.id, t.name, t.createdAt, t.revoked ? "revoked" : "live"]);
        console.log(rows.length ? renderTable(["id", "name", "created", "state"], rows) : "no tokens");
      },
    },
    {
      name: "revoke",
      summary: "Revoke a token by id or name",
      description: "The token stops working on the next request.",
      args: [{ name: "ID_OR_NAME", required: true, summary: "Token id or name" }],
      options: [tokensOpt],
      examples: ["pai uhp token revoke laptop"],
      run: (ctx) => {
        const id = ctx.args.ID_OR_NAME as string;
        if (!revokeToken(tokensFile(ctx), id)) throw new CliError(`no live token "${id}"`, "pai uhp token list");
        console.log(ok(`revoked ${id}`));
      },
    },
  ],
};

export const uhpCommand: CommandDef = {
  name: "uhp",
  summary: "PAI as a Unified Harness Protocol server: serve, token",
  description: "Lets any UHP client use PAI's workers (providers x classes) as harnesses.",
  examples: ["pai uhp serve", "pai uhp token create laptop"],
  subcommands: [serveCommand, tokenCommand],
};
