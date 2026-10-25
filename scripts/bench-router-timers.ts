/**
 * bench-router-timers.ts — cost of the two sync calls the live CPU profile named on the idle router:
 * workersLogDir (re-parsed the shipped workers.yaml each call) and readLiveInstances (one lsof child
 * process per ready managed instance per call). Prints ms per 200 calls.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkersConfig } from "../src/workers/config.js";
import { workersLogDir } from "../src/workers/paths.js";
import { readLiveInstances, writeInstances, type LocalInstance } from "../src/workers/local-instances.js";

const N = 200;
const cfg = defaultWorkersConfig();
let t = performance.now();
for (let i = 0; i < N; i++) workersLogDir(cfg);
console.log(`workersLogDir x${N}: ${(performance.now() - t).toFixed(0)}ms`);

const dir = mkdtempSync(join(tmpdir(), "bench-li-"));
const row = { id: "m#1", model: "m", provider: "m", port: 1, pid: process.pid, state: "ready", origin: "managed" } as unknown as LocalInstance;
writeInstances(dir, [row]);
t = performance.now();
for (let i = 0; i < N; i++) readLiveInstances(dir);
console.log(`readLiveInstances x${N}: ${(performance.now() - t).toFixed(0)}ms`);
