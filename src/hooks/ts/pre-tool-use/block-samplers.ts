#!/usr/bin/env node

/**
 * block-samplers.ts — PreToolUse (Bash)
 *
 * Denies a command that runs mactop, htop, btop, glances, asitop or powermetrics
 * with a sampling interval. I/O only; the decision is lib/sampler-gate.ts.
 */

import { decideSamplerGate, type SamplerGateInput } from "../lib/sampler-gate.js";
import { allow, deny, readGateInput } from "../lib/gate-io.js";

async function main(): Promise<void> {
  const input = await readGateInput<SamplerGateInput>();
  if (!input) return allow();
  const d = decideSamplerGate(input);
  if (d.decision === "deny") return deny(d.reason);
  return allow();
}

main().catch(() => process.exit(0));
