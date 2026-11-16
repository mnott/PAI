// throwaway probe of the two failing scenarios, same code paths as freeze.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeMsOf, frozenMsFor } from "../src/workers/freeze.js";
import { TroubleWatcher } from "../src/workers/worker-trouble.js";
import { escalationReason } from "../src/workers/reroute.js";

process.env.PAI_FREEZE_FILE = join(mkdtempSync(join(tmpdir(), "probe2-")), "freeze.json");
delete process.env.PAI_WORKER;
let now = Date.now();
const marker = (since: number, ids: string[]): void => {
  writeFileSync(process.env.PAI_FREEZE_FILE!, JSON.stringify({ since, by: "t", pids: ids.map((id) => ({ pid: 100, lstart: "x", kind: "worker", id, role: "worker", depth: 0 })) }), "utf8");
};
const acct = (w: Record<string, number>): void => {
  writeFileSync(`${process.env.PAI_FREEZE_FILE}.acct`, JSON.stringify({ totalMs: Math.max(0, ...Object.values(w)), workers: w }), "utf8");
};

// --- TroubleWatcher scenario
{
  const sent: string[] = [];
  let n = 0;
  const msg = { toSession: async (_o: unknown, t: string) => (sent.push(t), n++, true) } as never;
  const w = new TroubleWatcher("L1", "lbl", msg, {} as never, () => now);
  now -= 30 * 60_000;
  w.activity();
  now += 30 * 60_000;
  w.tick();
  await w.flush();
  console.log("A sent:", n);
  marker(now - 58 * 60_000, ["L1"]);
  now += 58 * 60_000;
  w.tick();
  await w.flush();
  console.log("B sent:", n);
  acct({ L1: 58 * 60_000 });
  rmSync(process.env.PAI_FREEZE_FILE!);
  w.tick();
  await w.flush();
  console.log("C sent:", n, "frozenMsFor:", frozenMsFor("L1", now), "quietActiveMs:", activeMsOf("L1", now - (w as unknown as { lastActivity: number }).lastActivity, now));
  (w as unknown as { lastSent: number }).lastSent = -Infinity;
  w.activity();
  now += 10 * 60_000;
  w.tick();
  await w.flush();
  console.log("D sent:", n, "line:", sent[1]?.slice(0, 70));
}

// --- escalationReason scenario
{
  const dir = mkdtempSync(join(tmpdir(), "esc-"));
  const specFile = join(dir, "spec.txt");
  writeFileSync(specFile, "task", "utf8");
  const startedStamp = (t: number): string => new Date(t).toISOString().slice(0, 19).replace("T", " ");
  const at = now;
  const s = { id: "L1", pid: 100, state: "running", label: "", started: startedStamp(now - 60 * 60_000), spec: specFile } as never;
  const p = { queuedMaxMin: 5, stallMaxMin: 30, stallFailedCalls: 5 };
  marker(at - 60 * 60_000, ["L1"]);
  console.log("E frozen:", escalationReason(s, at, p));
  acct({ L1: 60 * 60_000 });
  rmSync(process.env.PAI_FREEZE_FILE!);
  console.log("F thawed:", escalationReason(s, at, p), "frozenMsFor(at):", frozenMsFor("L1", at));
}
rmSync(process.env.PAI_FREEZE_FILE, { force: true });
