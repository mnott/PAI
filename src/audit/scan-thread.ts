/**
 * scan-thread.ts — worker_thread entry for the end-of-run scan.
 *
 * scanTranscript runs rule regexes synchronously, so a pathological pattern or
 * transcript cannot be interrupted from the same thread. The caller runs this
 * file in a worker_thread instead and terminates it when its budget is spent
 * (workers/scan.ts scanInThread). Input: workerData { paths, rules }; output:
 * one message with the findings.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { Rule } from "../hooks/ts/lib/rules/types.js";
import { scanTranscript, type Finding } from "./scan.js";

async function main(): Promise<void> {
  const { paths, rules } = workerData as { paths: string[]; rules: Rule[] };
  const findings: Finding[] = [];
  for (const p of paths) findings.push(...(await scanTranscript(p, rules)));
  parentPort?.postMessage({ findings });
}

main().catch((e) => parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) }));
