/**
 * Start-time resource checks for local model instances: free memory (measured,
 * minus a reserve), what a model needs, and a free port for the next instance.
 * Everything that touches the machine is injected, so tests need no real
 * vm_stat, sockets or model directories.
 */

import { createServer } from "node:net";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { parseVmStat } from "../router/system.js";

export const DEFAULT_RESERVE_GB = 4;
/** How many ports above the base are tried. */
export const PORT_SPAN = 50;
const GB = 1024 ** 3;

export interface MemoryDeps {
  /** `vm_stat` stdout, undefined when unavailable. */
  vmStat: () => Promise<string | undefined>;
  /** `sysctl -n hw.memsize` in bytes. */
  memTotal: () => Promise<number | undefined>;
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : String(stdout)));
  });
}

export const realMemoryDeps: MemoryDeps = {
  vmStat: () => run("vm_stat", []),
  memTotal: async () => {
    const n = Number((await run("sysctl", ["-n", "hw.memsize"]))?.trim());
    return n > 0 ? n : undefined;
  },
};

/**
 * Memory a new server can take, GB: reclaimable (free + speculative + inactive)
 * minus the reserve. Undefined when it cannot be measured.
 */
export async function freeMemoryGb(
  reserveGb: number = DEFAULT_RESERVE_GB,
  deps: MemoryDeps = realMemoryDeps,
): Promise<number | undefined> {
  const [out, total] = await Promise.all([deps.vmStat(), deps.memTotal()]);
  if (!out || total === undefined) return undefined;
  const vm = parseVmStat(out, total);
  if (!vm) return undefined;
  const reclaimable = total - vm.used;
  return Math.max(0, reclaimable / GB - reserveGb);
}

/** Size of a model directory (or file) in GB, 0 when it does not exist. */
export function sizeOnDiskGb(path: string): number {
  const walk = (p: string): number => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return 0;
    }
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of readdirSync(p)) total += walk(join(p, name));
    return total;
  };
  return walk(path) / GB;
}

export interface NeedInputs {
  /** `memoryGb` from the model catalogue. */
  memoryGb?: number;
  /** Last measured footprint of this model (inventory), GB. */
  footprintGb?: number;
  /** Size of the model files, GB. */
  diskGb?: number;
}

/** max(config hint, last measured footprint, disk size x 1.1); 0 when nothing is known. */
export function neededGb(n: NeedInputs): number {
  const disk = n.diskGb !== undefined ? n.diskGb * 1.1 : 0;
  return Math.max(n.memoryGb ?? 0, n.footprintGb ?? 0, disk);
}

export interface StartCheck {
  ok: boolean;
  /** Refusal text, set when !ok. */
  message?: string;
  needGb: number;
  freeGb: number | undefined;
}

export interface CheckStartInput {
  /** Instance label for the message, e.g. "gyro-m #2". */
  label: string;
  needGb: number;
  /** From freeMemoryGb; undefined = unmeasurable (start allowed). */
  freeGb: number | undefined;
  reserveGb?: number;
  /** GB already promised to starts that are not ready yet. */
  inflightGb?: number;
  force?: boolean;
}

const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();

/** Decide whether an instance may start. A start in flight counts as already used. */
export function checkStart(i: CheckStartInput): StartCheck {
  const reserve = i.reserveGb ?? DEFAULT_RESERVE_GB;
  const free = i.freeGb === undefined ? undefined : Math.max(0, i.freeGb - (i.inflightGb ?? 0));
  const base = { needGb: i.needGb, freeGb: free };
  if (i.force || free === undefined || i.needGb <= free) return { ok: true, ...base };
  return {
    ok: false,
    ...base,
    message: `refuse to start ${i.label}: needs ~${fmt(i.needGb)} GB, free ${fmt(free)} GB (reserve ${fmt(reserve)})`,
  };
}

/** True when 127.0.0.1:port can be bound right now. */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/**
 * First port from basePort up (+PORT_SPAN) that is neither taken (state file,
 * catalogue, listening) nor un-bindable. Throws when none is free.
 */
export async function allocatePort(
  basePort: number,
  taken: Iterable<number>,
  bindable: (port: number) => Promise<boolean> = canBind,
): Promise<number> {
  const skip = new Set(taken);
  for (let p = basePort; p <= basePort + PORT_SPAN; p++) {
    if (skip.has(p)) continue;
    if (await bindable(p)) return p;
  }
  throw new Error(`no free port in ${basePort}-${basePort + PORT_SPAN}`);
}
