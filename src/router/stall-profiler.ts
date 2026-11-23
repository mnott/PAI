import inspector from "node:inspector";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface StallProfiler {
  /** a stall of stallMs just ended (now); save the rolling profile window */
  onStall(stallMs: number, inflight: string[]): void;
  stop(): void;
}

export interface ProfilerOptions {
  dir?: string;
  keep?: number;
  windowMs?: number;
  log: (line: string) => void;
}

/**
 * Opt-in: the env var `PAI_ROUTER_PROFILE` or config `router.profileStalls: true`.
 * The env var alone does not survive `pai router restart` — the gapless handover
 * spawns the successor from the old router's environment, not the caller's — so the
 * config key is the durable switch. Either one turns it on; both off = off.
 */
export function stallProfilerEnabled(env: NodeJS.ProcessEnv = process.env, profileStalls?: boolean): boolean {
  if (profileStalls === true) return true;
  return /^(1|true|on|yes)$/i.test(env.PAI_ROUTER_PROFILE ?? "");
}

/**
 * Opt-in (PAI_ROUTER_PROFILE=1 or router.profileStalls: true): a ~1 ms sampling CPU profile that restarts every
 * windowMs so it stays bounded. On a stall the current window is stopped, written to
 * <dir>/<ts>.cpuprofile (with a paiStall block: end epoch + stall length so the analyzer
 * can cut the stall's time range) and a fresh window starts. Only the last `keep` files stay.
 */
export function startStallProfiler(o: ProfilerOptions): StallProfiler {
  const dir = o.dir ?? path.join(os.homedir(), ".pai", "logs", "router-profiles");
  const keep = o.keep ?? 20;
  const session = new inspector.Session();
  session.connect();
  let busy = false;
  const post = (m: string, p?: object) =>
    new Promise<any>((res, rej) => session.post(m, p as any, (e, r) => (e ? rej(e) : res(r))));
  const begin = async () => {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 1000 });
    await post("Profiler.start");
  };
  const restart = async (save?: { stallMs: number; inflight: string[] }) => {
    if (busy) return;
    busy = true;
    try {
      const r = await post("Profiler.stop");
      if (save) {
        const endedAt = Date.now();
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `${new Date(endedAt).toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
        fs.writeFileSync(f, JSON.stringify({ ...r.profile, paiStall: { endedAtMs: endedAt, stallMs: save.stallMs, inflight: save.inflight } }));
        const files = fs.readdirSync(dir).filter((x) => x.endsWith(".cpuprofile")).sort();
        for (const x of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, x), { force: true });
        o.log(`${new Date(endedAt).toISOString()} stall profile saved: ${f}`);
      }
      await post("Profiler.start");
    } catch (e) {
      o.log(`stall profiler error: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  begin().catch((e) => o.log(`stall profiler start failed: ${(e as Error).message}`));
  const timer = setInterval(() => void restart(), o.windowMs ?? 30_000);
  timer.unref();
  return {
    onStall: (stallMs, inflight) => void restart({ stallMs, inflight }),
    stop: () => {
      clearInterval(timer);
      try { session.disconnect(); } catch { /* ignore */ }
    },
  };
}
