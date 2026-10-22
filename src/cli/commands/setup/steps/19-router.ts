/** Step 19: the model router and its cockpit (enabled, port, reach). Answers go to config.yaml as router.enabled / router.port / router.bind. */

import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { loadConfig } from "../../../../daemon/config.js";
import { resolveBindAddress } from "../../../../router/cockpit-auth.js";
import { c, line, section, type Rl, prompt, promptMenu, promptYesNo, readConfigRaw, setupOptions } from "../utils.js";

export interface PortProbe { free: boolean; holder?: string }
export type PortProbeFn = (port: number) => Promise<PortProbe>;

/** Tries to listen on loopback; when taken, asks lsof who holds it. */
export const defaultPortProbe: PortProbeFn = (port) =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => {
      const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      const holder = (r.stdout ?? "").split("\n")[1]?.trim().split(/\s+/).slice(0, 2).join(" pid ") || undefined;
      resolve({ free: false, holder });
    });
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve({ free: true })));
  });

export function validPort(v: unknown): number | null {
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v).trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

/** `loopback`, `tailscale` or a dotted IPv4 (never 0.0.0.0); returns the normalised value or null. */
export function validBind(v: string): string | null {
  const b = v.trim().toLowerCase();
  return resolveBindAddress(b) === null && b !== "tailscale" ? null : b || "loopback";
}

export async function stepRouter(rl: Rl, probe: PortProbeFn = defaultPortProbe): Promise<Record<string, unknown>> {
  section("Step 19: Router and Cockpit (Optional)");
  line();
  line("  The router accounts model usage, schedules local models and serves the cockpit page.");
  line("  The daemon keeps it running when enabled.");
  line();

  const cfg = loadConfig().router;
  const raw = (readConfigRaw().router ?? {}) as Record<string, unknown>;
  const flags = setupOptions.router ?? {};

  const enabled = flags.enabled ?? (await promptYesNo(rl, "Enable the router and cockpit?", typeof raw.enabled === "boolean" ? raw.enabled : true));
  if (!enabled) {
    console.log(c.ok("Router disabled. Enable later: pai config set router.enabled true"));
    return { router: { ...raw, enabled: false } };
  }

  // Port: the config default (router.port) unless the user picks another; the router's own port is not "taken".
  const ownPort = raw.enabled === true ? cfg.port : undefined;
  const check = async (port: number): Promise<string | null> => {
    if (port === ownPort) return null;
    const p = await probe(port);
    return p.free ? null : `Port ${port} is in use${p.holder ? ` by ${p.holder}` : ""}.`;
  };
  let port: number;
  if (flags.port !== undefined) {
    const v = validPort(flags.port);
    if (v === null) throw new Error(`--router-port must be a number from 1024 to 65535, got "${flags.port}"`);
    const taken = await check(v);
    if (taken) throw new Error(`${taken} Choose another with --router-port.`);
    port = v;
  } else {
    port = cfg.port;
    for (;;) {
      const answer = await prompt(rl, chalk.bold(`  Cockpit port [${cfg.port}]: `), "");
      const v = answer === "" ? cfg.port : validPort(answer);
      if (v === null) { console.log(c.warn("Enter a port from 1024 to 65535.")); continue; }
      const taken = await check(v);
      if (!taken) { port = v; break; }
      console.log(c.warn(taken));
      if (setupOptions.yes) throw new Error(`${taken} Choose another with --router-port.`);
    }
  }

  // Reach
  let bind: string;
  if (flags.bind !== undefined) {
    const v = validBind(flags.bind);
    if (v === null) throw new Error(`--router-bind must be loopback, tailscale or an IPv4 address (not 0.0.0.0), got "${flags.bind}"`);
    bind = v;
  } else {
    const current = String(raw.bind ?? "loopback");
    line();
    line("  Who can reach the cockpit? Beyond loopback it is reachable from other devices (behind a token).");
    line();
    const idx = await promptMenu(rl, [
      { label: "loopback", description: "This machine only (127.0.0.1)." },
      { label: "tailscale", description: "Your other Tailscale devices." },
      { label: "explicit address", description: "A specific IPv4 address of this machine." },
    ], current === "tailscale" ? 1 : 0);
    bind = idx === 0 ? "loopback" : "tailscale";
    if (idx === 2) {
      for (;;) {
        const a = validBind(await prompt(rl, chalk.bold("  IPv4 address: "), ""));
        if (a && a !== "tailscale") { bind = a; break; }
        console.log(c.warn("Enter a dotted IPv4 address (not 0.0.0.0)."));
      }
    }
  }
  if (bind !== "loopback") console.log(c.warn(`  The cockpit will be reachable from other devices via ${bind}; it asks for the token in ~/.pai/router-cockpit.token.`));
  if (bind === "tailscale" && resolveBindAddress("tailscale") === null) console.log(c.warn("  Tailscale is not up here; the extra listener starts once it is."));

  console.log(c.ok(`Router enabled on port ${port}, reach: ${bind}.`));
  return { router: { ...raw, enabled: true, port, bind } };
}
