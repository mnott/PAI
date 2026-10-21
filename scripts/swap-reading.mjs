// Router swap reading: node scripts/swap-reading.mjs <cli-entry> <old|new> <port> [swaps]
// Hammers the router with keep-alive clients while it is swapped N times; prints failed requests (x000) per swap.
// mode handover = old router gets SIGUSR2 and passes its listening socket to its successor (new pid found via lsof).
// mode old = supervisor signals the old router at spawn (pre 42a28287); mode new = new router gets --replace PID.
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [cli, mode, portArg, swapsArg] = process.argv.slice(2);
const port = Number(portArg);
const swaps = Number(swapsArg || 20);
const home = mkdtempSync(join(tmpdir(), "swap-home-"));
const env = { ...process.env, HOME: home };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function start(extra) {
  const c = spawn(process.execPath, [cli, "router", "run", "--port", String(port), ...extra], { stdio: "ignore", env, detached: true });
  c.unref();
  return c.pid;
}
function once() {
  return new Promise((resolve) => {
    const s = require_net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}
import net from "node:net";
const require_net = net;

let failures = 0;
const errs = {};
let swapT0 = 0;
const bad = (c) => { if (process.env.SWAP_DEBUG) console.log("fail", c, Date.now() - swapT0); failures++; errs[c] = (errs[c] || 0) + 1; };
let stop = false;
function client() {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  (async () => {
    while (!stop) {
      await new Promise((res) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/cockpit/system", agent, timeout: 3000 }, (r) => { r.resume(); r.on("end", res); r.on("error", (e) => { bad("resp-" + e.code); res(); }); });
        req.on("error", (e) => { bad(e.code); res(); });
        req.on("timeout", () => req.destroy());
      });
      await sleep(20);
    }
  })();
}

let cur = start([]);
for (let i = 0; i < 100 && !(await once()); i++) await sleep(100);
if (!(await once())) { console.log("router did not start"); process.exit(2); }
for (let i = 0; i < 4; i++) client();
await sleep(500);

const counts = [];
let dark = 0, darkStart = 0, maxDark = 0;
(async () => { while (!stop) { const up = await once(); const t = Date.now(); if (!up && !darkStart) darkStart = t; if (up && darkStart) { maxDark = Math.max(maxDark, t - darkStart); darkStart = 0; } await sleep(5); } })();
for (let n = 0; n < swaps; n++) {
  const before = failures;
  const old = cur;
  let handed = false;
  if (mode === "handover") {
    process.kill(old, "SIGUSR2");
    handed = true;
  } else if (mode === "new") cur = start(["--wait-bind", "10", "--replace", String(old)]);
  else { cur = start(["--wait-bind", "10"]); try { process.kill(old, "SIGTERM"); } catch { console.log("old gone", old); } }
  const t0 = Date.now();
  swapT0 = t0;
  if (handed) {
    while (Date.now() - t0 < 15000) {
      await sleep(20);
      let pids = [];
      pids = await new Promise((res) => execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }, (_e, out) => res((out || "").split("\n").filter(Boolean).map(Number))));
      const fresh = pids.find((p) => p !== old);
      if (fresh && !alive(old)) { cur = fresh; break; }
    }
  }
  while ((alive(old) || !(await once())) && Date.now() - t0 < 15000) await sleep(10);
  if (process.env.SWAP_DEBUG) console.log("swap done at", Date.now() - t0);
  await sleep(600);
  counts.push(failures - before);
}
stop = true;
await sleep(100);
try { process.kill(cur, "SIGTERM"); } catch {}
await sleep(2500);
try { process.kill(cur, "SIGKILL"); } catch {}
console.log(JSON.stringify(errs), `longest dark port window ${maxDark} ms (5 ms probe)`);
console.log(`${mode} swaps=${swaps} x000 per swap: ${counts.join(" ")} total=${counts.reduce((a, b) => a + b, 0)}`);
