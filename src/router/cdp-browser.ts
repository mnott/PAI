/**
 * Shared headless-Chrome helpers for the cockpit tests, the only place that spawns the browser. `launch` is the CDP launcher: every launch gets
 * its own fresh user-data-dir (so a DevToolsActivePort left by an earlier Chrome can never be read) and the previous browser is killed and
 * awaited before a new one starts. `dumpDom` / `screenshot` are the one-shot variants: a fresh profile per call, bounded retry on empty output.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = process.env.CHROME_BIN ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let proc: ChildProcess | undefined;
let ws: WebSocket | undefined;
let dir = "";

/** Kill the running browser, wait for it to exit, remove its profile. Call from afterAll. */
export async function closeBrowser(): Promise<void> {
  try { ws?.close(); } catch { /* closed */ }
  ws = undefined;
  const p = proc;
  proc = undefined;
  if (p && p.exitCode === null && p.signalCode === null) {
    const exited = new Promise<void>((r) => p.once("exit", () => r()));
    p.kill("SIGKILL");
    await exited;
  }
  if (dir) try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the browser may still be flushing its profile */ }
  dir = "";
}

export async function launch(w: number, h: number) {
  await closeBrowser();
  dir = mkdtempSync(join(tmpdir(), "cockpit-cdp-"));
  const mine = spawn(CHROME!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, `--window-size=${w},${h}`, "--no-first-run", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "about:blank"], { stdio: "ignore" });
  proc = mine;
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(200);
    try { port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { /* not up yet */ }
  }
  if (!port) throw new Error("chrome did not start");
  let tabs: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && !tabs.some((t) => t.type === "page"); i++) { try { tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof tabs; } catch { /* not up yet */ } if (!tabs.some((t) => t.type === "page")) await sleep(200); }
  const sock = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  ws = sock;
  await new Promise((r) => { sock.onopen = r; });
  let id = 0;
  const pend = new Map<number, (d: { result: unknown }) => void>();
  sock.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id && pend.has(d.id)) { pend.get(d.id)!(d); pend.delete(d.id); } };
  const send = (method: string, params: object = {}) => new Promise<{ result: any }>((r) => { const i = ++id; pend.set(i, r as never); sock.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const ev = async <T>(expr: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value as T;
  };
  return { send, ev };
}

const oneShots = new Set<ChildProcess>();

/** Kill every one-shot Chrome still running. Call from afterAll. */
export function killChromes(): void { for (const c of oneShots) c.kill("SIGKILL"); }

export interface ShotOpts { width: number; height: number; budgetMs: number; scrollbars?: boolean }

async function oneShot(opts: ShotOpts, extra: string[], ok: (stdout: string) => boolean): Promise<string> {
  let last: unknown = new Error("chrome produced no output");
  for (let attempt = 0; attempt < 3; attempt++) {
    const profile = mkdtempSync(join(tmpdir(), "cockpit-shot-"));
    const args = ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--no-first-run", ...(opts.scrollbars === false ? [] : ["--hide-scrollbars"]), `--user-data-dir=${profile}`, `--window-size=${opts.width},${opts.height}`, `--virtual-time-budget=${opts.budgetMs}`, ...extra];
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const c = execFile(CHROME!, args, { encoding: "utf8", timeout: 90_000, maxBuffer: 64 << 20 }, (err, stdout) => { oneShots.delete(c); err ? reject(err) : resolve(stdout); });
        oneShots.add(c);
      });
      if (ok(out)) return out;
    } catch (e) { last = e; } finally { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  }
  throw last;
}

/** The DOM Chrome serialises after the virtual-time budget has run out. */
export const dumpDom = (url: string, opts: ShotOpts): Promise<string> => oneShot(opts, ["--dump-dom", url], (out) => out.trim() !== "");

/** Writes a PNG of the page to `file`. */
export async function screenshot(url: string, file: string, opts: ShotOpts): Promise<void> {
  await oneShot(opts, [`--screenshot=${file}`, url], () => existsSync(file) && statSync(file).size > 0);
}
