/**
 * `pai uhp`: PAI as a Unified Harness Protocol server. Behaviour lives in
 * src/uhp-server/; this file declares names, flags and help.
 */

import { cliVersion } from "../run.js";
import { createToken, readTokens, revokeToken, tokensFilePath } from "../../uhp-server/auth.js";
import { createUhpServer } from "../../uhp-server/server.js";
import { tenantExists } from "../../tenants/tenants.js";
import { CliError, type CommandDef } from "../define.js";
import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";

const out = (s: string) => process.stdout.write(s + "\n");
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const tokensOpt = { name: "tokens", type: "string" as const, value: "FILE", summary: "Tokens file (default: <PAI_HOME>/uhp/tokens.json)" };

const serveCmd: CommandDef = {
  name: "serve",
  summary: "Serve the UHP API (discovery, harnesses, models, responses, sessions)",
  description:
    "Starts the UHP HTTP server. GET /v1/uhp is open; every other endpoint needs a bearer token from `pai uhp token create`. Binds loopback by default; a non-loopback bind needs --allow-remote and at least one token, and TLS must be terminated in front.",
  options: [
    { name: "port", type: "number", value: "N", default: 8791, summary: "Port (0 picks a free one)" },
    { name: "bind", type: "string", value: "ADDR", default: "127.0.0.1", summary: "Address to bind" },
    { name: "allow-remote", type: "boolean", summary: "Permit a non-loopback --bind (requires tokens)" },
    { name: "cwd", type: "string", value: "DIR", summary: "Directory the workers run in (default: here)" },
    tokensOpt,
  ],
  examples: ["pai uhp serve", "pai uhp serve --port 0", "pai uhp serve --bind 0.0.0.0 --allow-remote"],
  run: async (ctx) => {
    const bind = String(ctx.opts.bind ?? "127.0.0.1");
    const tokensPath = tokensFilePath(ctx.opts.tokens as string | undefined);
    if (!LOOPBACK.has(bind)) {
      if (!ctx.opts["allow-remote"]) throw new CliError(`refusing to bind ${bind}: not loopback`, "pass --allow-remote (and create tokens)");
      if (!readTokens(tokensPath).some((t) => !t.revokedAt)) throw new CliError("refusing to serve remotely without tokens", "pai uhp token create");
      process.stderr.write("pai uhp: TLS required: put a TLS terminator in front\n");
    }
    const cwd = ctx.opts.cwd ? String(ctx.opts.cwd) : process.cwd();
    const server = createUhpServer({ tokensPath, implVersion: cliVersion(), runs: { logDir: workersLogDir(readWorkersSection().workers), cwd } });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(ctx.opts.port ?? 8791), bind, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : ctx.opts.port;
    out(`uhp: listening on http://${bind}:${port}`);
    await new Promise<void>((resolve) => {
      for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => server.close(() => resolve()));
    });
  },
};

const createCmd: CommandDef = {
  name: "create",
  summary: "Create a bearer token (shown once)",
  description: "Stores the sha256 of a new token; the plaintext is printed once. --scope limits the token to the named harness ids; --tenant binds it to a tenant (its rules directory and audit log).",
  options: [
    { name: "label", type: "string", value: "TEXT", summary: "Free-text label" },
    { name: "scope", type: "string", value: "ID,ID", summary: "Harness ids the token may see (default: all)" },
    { name: "tenant", type: "string", value: "NAME", summary: "Tenant whose rules and audit log the token's decisions use (default: local)" },
    tokensOpt,
  ],
  examples: ["pai uhp token create --label ci"],
  run: (ctx) => {
    const scope = typeof ctx.opts.scope === "string" ? ctx.opts.scope.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const tenant = typeof ctx.opts.tenant === "string" && ctx.opts.tenant ? ctx.opts.tenant : undefined;
    if (tenant && !tenantExists(tenant)) throw new CliError(`unknown tenant ${tenant}`, "add tenants.<name>.rulesDir to the config; see docs/tenants.md");
    const { token, record } = createToken(tokensFilePath(ctx.opts.tokens as string | undefined), String(ctx.opts.label ?? ""), scope, tenant);
    out(`${record.id}  ${token}`);
  },
};

const revokeCmd: CommandDef = {
  name: "revoke",
  summary: "Revoke a token (takes effect on the next request)",
  description: "Marks the token revoked; a revoked token is refused like an unknown one.",
  args: [{ name: "ID", summary: "Token id from `pai uhp token list`", required: true }],
  options: [tokensOpt],
  examples: ["pai uhp token revoke tok_1a2b3c4d"],
  run: (ctx) => {
    const rec = revokeToken(tokensFilePath(ctx.opts.tokens as string | undefined), String(ctx.args.ID));
    if (!rec) throw new CliError(`no token ${String(ctx.args.ID)}`, "pai uhp token list");
    out(`revoked ${rec.id}`);
  },
};

const listCmd: CommandDef = {
  name: "list",
  summary: "List tokens (ids and hash prefixes, never the secret)",
  description: "Shows id, state, label, scope and a short hash prefix per token.",
  options: [tokensOpt],
  examples: ["pai uhp token list"],
  run: (ctx) => {
    const tokens = readTokens(tokensFilePath(ctx.opts.tokens as string | undefined));
    if (!tokens.length) {
      out("no tokens");
      return;
    }
    for (const t of tokens) out(`${t.id}  ${t.revokedAt ? "revoked" : "active "}  ${t.hash.slice(0, 8)}  ${t.scope ? `scope=${t.scope.length}` : "scope=all"}  tenant=${t.tenant ?? "local"}  ${t.label}`);
  },
};

const tokenCmd: CommandDef = {
  name: "token",
  summary: "Manage UHP bearer tokens",
  description: "Tokens are stored as sha256 hashes in <PAI_HOME>/uhp/tokens.json.",
  examples: ["pai uhp token create", "pai uhp token list", "pai uhp token revoke tok_1a2b3c4d"],
  subcommands: [createCmd, revokeCmd, listCmd],
};

export const uhpCommand: CommandDef = {
  name: "uhp",
  summary: "Serve PAI workers over the Unified Harness Protocol",
  description: "PAI as a UHP server: discovery, harness and model listing for the enabled provider/class pairs, bearer-token auth. See docs/uhp.md.",
  examples: ["pai uhp token create", "pai uhp serve"],
  subcommands: [serveCmd, tokenCmd],
};
