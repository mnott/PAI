/**
 * Machine-wide test slot. Concurrent vitest runs (merge gate, each worker's
 * own run, the orchestrator's re-runs) each spawn a node pool and saturate the
 * machine, so every test run takes one slot from a file lock under
 * PAI_HOME/locks/test-slot-N (N < workers.tests.maxConcurrent, default 1).
 * A lock names its holder pid; a dead pid is taken over. The holder exports
 * PAI_TEST_SLOT_HELD to its children so a nested run (the gate's verify
 * command inside a wrapped Bash call) does not wait on its own slot.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";

export const SLOT_HELD_ENV = "PAI_TEST_SLOT_HELD";
const POLL_MS = 500;

export interface SlotOptions {
  dir?: string;
  slots?: number;
  /** Who is asking, shown to the ones waiting (worker id or pid). */
  holder?: string;
  pid?: number;
  /** Receives the "waiting" line (once). */
  log?: (s: string) => void;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
}

export interface SlotLease {
  path: string;
  release(): void;
}

/** workers.tests.maxConcurrent from the config (default 1); PAI_TEST_SLOTS overrides. */
export function configuredSlots(): number {
  const env = Number(process.env.PAI_TEST_SLOTS);
  if (Number.isInteger(env) && env >= 1) return env;
  try {
    const w = effectiveMainConfig(paiConfigFilePath()).workers as { tests?: { maxConcurrent?: unknown } } | undefined;
    const n = w?.tests?.maxConcurrent;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1) return n;
  } catch {
    // unreadable config: the default
  }
  return 1;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(file: string): { pid: number; holder: string } | null {
  try {
    const [pid, ...rest] = readFileSync(file, "utf8").trim().split(" ");
    return Number.isInteger(Number(pid)) && pid ? { pid: Number(pid), holder: rest.join(" ") || pid } : null;
  } catch {
    return null;
  }
}

/** One attempt over all slots. Returns the lease, or the holder of the first slot when all are taken. */
function tryAcquire(o: Required<Pick<SlotOptions, "dir" | "slots" | "holder" | "pid" | "isAlive">>): SlotLease | { heldBy: string } {
  mkdirSync(o.dir, { recursive: true });
  let heldBy = "unknown";
  for (let n = 0; n < o.slots; n++) {
    const path = join(o.dir, `test-slot-${n}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, `${o.pid} ${o.holder}\n`);
        closeSync(fd);
        return {
          path,
          release: () => {
            if (readHolder(path)?.pid === o.pid) {
              try {
                unlinkSync(path);
              } catch {
                // already gone
              }
            }
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const cur = readHolder(path);
      if (cur && o.isAlive(cur.pid)) {
        if (n === 0) heldBy = cur.holder;
        break;
      }
      // stale (dead pid, or a half-written file): take over by removing and retrying the exclusive create
      try {
        unlinkSync(path);
      } catch {
        // another waiter got there first
      }
    }
  }
  return { heldBy };
}

function resolveOptions(opts: SlotOptions) {
  const pid = opts.pid ?? process.pid;
  return {
    dir: opts.dir ?? paiHomePath("locks"),
    slots: opts.slots ?? configuredSlots(),
    pid,
    holder: opts.holder ?? process.env.PAI_WORKER_ID ?? `pid ${pid}`,
    isAlive: opts.isAlive ?? pidAlive,
  };
}

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Takes a test slot, blocking (synchronously) until one is free. */
export function acquireTestSlotSync(opts: SlotOptions = {}): SlotLease {
  const o = resolveOptions(opts);
  const log = opts.log ?? ((s: string) => void process.stderr.write(s));
  let announced = false;
  for (;;) {
    const r = tryAcquire(o);
    if ("release" in r) return r;
    if (!announced) log(`waiting for the test slot (held by ${r.heldBy})\n`);
    announced = true;
    sleepSync(opts.pollMs ?? POLL_MS);
  }
}

/** Async twin of acquireTestSlotSync that keeps the event loop running while it waits. */
export async function acquireTestSlot(opts: SlotOptions = {}): Promise<SlotLease> {
  const o = resolveOptions(opts);
  const log = opts.log ?? ((s: string) => void process.stderr.write(s));
  let announced = false;
  for (;;) {
    const r = tryAcquire(o);
    if ("release" in r) return r;
    if (!announced) log(`waiting for the test slot (held by ${r.heldBy})\n`);
    announced = true;
    await new Promise((res) => setTimeout(res, opts.pollMs ?? POLL_MS));
  }
}

/** True inside a process tree that already holds a slot. */
export function holdsTestSlot(): boolean {
  return Boolean(process.env[SLOT_HELD_ENV]);
}
