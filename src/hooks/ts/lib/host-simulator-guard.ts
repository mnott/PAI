/**
 * host-simulator-guard.ts — iOS simulators run in a VM (vmac), never on the
 * operator's screen. Denies, on the host, commands that boot or drive a
 * simulator: `xcrun simctl boot|launch|io`, `open -a Simulator` /
 * `open .../Simulator.app`, launching Device Hub, and
 * `xcodebuild test ... -destination 'platform=iOS Simulator...'`.
 * Read-only simctl (list, getenv, ...) stays allowed.
 *
 * Matching is on executed command words (splitSegments + words + stripPrefix
 * from build-gate), never on raw text: a grep pattern or a message that
 * contains `simctl boot` is not a command and passes. `sh -c '<cmd>'`
 * payloads are checked too.
 *
 * Off switches: VMAC_HOST_SIM=1 in the process env or as a leading
 * assignment on the segment (deliberate host run). Never denies in a VM
 * guest: VMAC_GUEST=1 (generic marker, set by every vmac exec/run in the
 * guest) or CASELEAF_IN_VM=1 in the env or as a leading assignment;
 * `sysctl -n kern.hv_vmm_present` = 1 is only an additional signal (asked
 * once, only when a command already looks like a host simulator run).
 */

import { execFileSync } from "node:child_process";
import { splitSegments, stripPrefix, words } from "./build-gate.js";

export const HOST_SIM_MESSAGE =
  "iOS simulators run in a VM, not on the operator's screen: use `vmac run <task>` (or the project's tools/vm.sh). Override for a deliberate host run: VMAC_HOST_SIM=1.";

const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);
const SIM_APP = /(?:^|\/)(?:Simulator|Device ?Hub)(?:\.app)?\/?$/i;
const SIM_DEST = /platform=iOS(?: |%20)?Simulator/i;
const OPT_OUT = /^(?:VMAC_HOST_SIM|VMAC_GUEST|CASELEAF_IN_VM)=["']?1["']?$/;
const SIMCTL_DRIVE = /^(boot|launch|io)$/;

function leading(ws: string[]): string[] {
  const out: string[] = [];
  for (const w of ws) {
    if (!/^[A-Za-z_]\w*=/.test(w)) break;
    out.push(w);
  }
  return out;
}

function hostSim(ws: string[], depth: number): boolean {
  const w = stripPrefix(ws);
  if (!w.length) return false;
  const bin = base(w[0]);
  if (bin === "xcrun") {
    const rest = w.slice(1).filter((a) => !a.startsWith("-"));
    if (base(rest[0] ?? "") === "simctl") return SIMCTL_DRIVE.test(rest[1] ?? "");
    return false;
  }
  if (bin === "simctl") return SIMCTL_DRIVE.test(w.slice(1).find((a) => !a.startsWith("-")) ?? "");
  if (bin === "open") {
    const named = w.some((a, i) => a === "-a" && SIM_APP.test(w[i + 1] ?? ""));
    return named || w.slice(1).some((a) => /(?:^|\/)(?:Simulator|DeviceHub|Device Hub)\.app\/?$/.test(a));
  }
  if (bin === "xcodebuild") {
    const test = w.some((a) => a === "test" || a === "test-without-building");
    const dest = w.some((a, i) => (a === "-destination" && SIM_DEST.test(w[i + 1] ?? "")) || (a.startsWith("-destination=") && SIM_DEST.test(a)));
    return test && dest;
  }
  if (bin === "bash" || bin === "sh" || bin === "zsh") {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined && depth < 3) return scan(w[c + 1], depth + 1);
  }
  return false;
}

function scan(command: string, depth: number): boolean {
  return splitSegments(command).some((seg) => {
    const ws = words(seg);
    if (leading(ws).some((a) => OPT_OUT.test(a))) return false;
    return hostSim(ws, depth);
  });
}

let vmm: boolean | undefined;
function sysctlVmm(): boolean {
  if (vmm === undefined) {
    try {
      vmm = execFileSync("sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "1";
    } catch {
      vmm = false;
    }
  }
  return vmm;
}

export function hostSimulatorReason(
  command: string,
  env: Record<string, string | undefined>,
  hostVmmPresent?: boolean,
): string | null {
  if (env.VMAC_HOST_SIM === "1" || env.VMAC_GUEST === "1" || env.CASELEAF_IN_VM === "1") return null;
  if (!scan(command, 0)) return null;
  return (hostVmmPresent ?? sysctlVmm()) ? null : HOST_SIM_MESSAGE;
}
