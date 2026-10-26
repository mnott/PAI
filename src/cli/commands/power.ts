/** `pai power ...`: the battery keep-above gate and charge-rate calibration (behaviour in src/daemon/battery-gate.ts). */

import { CliError, type CommandDef } from "../define.js";
import { readBattery } from "../../daemon/battery-guard.js";
import {
  CalibrateRefused,
  calibrate,
  gateThresholds,
  liveGateDeps,
  localBusyReason,
  powerStatus,
  powerStatusLines,
  readPowerConfig,
  saveCalibration,
  waitForBattery,
} from "../../daemon/battery-gate.js";
import { readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";

const out = (s: string): void => void process.stdout.write(s + "\n");

function numOpt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`--${name}: expected a non-negative number, got "${String(v)}"`);
  return n;
}

export const powerCommand: CommandDef = {
  name: "power",
  summary: "Battery: status, keep-above wait for the next local job, charge-rate calibration",
  description:
    "The battery guard's toolkit (config power.batteryGuard). `status` shows the reading, thresholds, the stored calibration and the estimated minutes until the keep-above gate opens. " +
    "`wait` blocks until the battery allows the next local job: at or above keepAbovePct it returns at once, below it it pauses in 10-minute steps (one line each) until resumeAtPct, then exits 0. " +
    "`calibrate` measures the idle charge rate (%/h) over N minutes and stores it in power.calibration; it refuses while a worker runs on a local provider. New local workers honour keepAbovePct by queueing; running ones are never stopped by it.",
  examples: ["pai power status", "pai power wait --above 40 --resume 45", "pai power calibrate --minutes 10", "pai power calibrate --load --minutes 10"],
  seeAlso: ["pai config set power.batteryGuard.keepAbovePct 40"],
  subcommands: [
    {
      name: "status",
      summary: "Battery %, charging state, thresholds, calibration, minutes until resume",
      description: "Reads the battery once and prints the guard thresholds, the keep-above gate state and the stored calibration.",
      examples: ["pai power status"],
      run: async () => {
        for (const l of powerStatusLines(await powerStatus({ read: () => readBattery() }))) out(l);
        return 0;
      },
    },
    {
      name: "wait",
      summary: "Block until the battery allows the next local job",
      description:
        "Exits 0 at once when the battery is at or above the keep-above level (--above, else power.batteryGuard.keepAbovePct). Below it, pauses in 10-minute steps, one line per pause, until the resume level (--resume, else resumeAtPct, else keep + 5). Exits 0 at once when no level is set or the battery is unreadable.",
      options: [
        { name: "above", type: "number", value: "PCT", summary: "Keep-above level (default: power.batteryGuard.keepAbovePct)" },
        { name: "resume", type: "number", value: "PCT", summary: "Resume level (default: power.batteryGuard.resumeAtPct)" },
        { name: "step", type: "number", value: "MIN", default: 10, summary: "Minutes per pause" },
      ],
      examples: ["pai power wait", "pai power wait --above 40 --resume 45"],
      run: async (ctx) => {
        const { cfg, calibration } = readPowerConfig();
        const t = gateThresholds(cfg, numOpt(ctx.opts.above, "above"), numOpt(ctx.opts.resume, "resume"));
        if (!t) {
          out("no keep-above level set (power.batteryGuard.keepAbovePct or --above): nothing to wait for");
          return 0;
        }
        await waitForBattery(t, calibration, liveGateDeps(out), { stepMs: (numOpt(ctx.opts.step, "step") ?? 10) * 60_000 });
        out("battery OK for the next local job");
        return 0;
      },
    },
    {
      name: "calibrate",
      summary: "Measure the charge rate (%/h) and store it in power.calibration",
      description:
        "Idle (default): reads the battery, waits N minutes, reads again, prints and stores the rate; refuses while a worker runs on a local provider or a benchmark is live. " +
        "--load measures the drain over the next N minutes of whatever is running instead and stores it as the load rate. The battery reports whole percents, so short windows are coarse.",
      options: [
        { name: "minutes", type: "number", value: "N", default: 10, summary: "Measuring window in minutes" },
        { name: "load", type: "boolean", default: false, summary: "Measure under whatever load runs now (no idle check)" },
      ],
      examples: ["pai power calibrate", "pai power calibrate --minutes 20", "pai power calibrate --load --minutes 10"],
      run: async (ctx) => {
        const minutes = numOpt(ctx.opts.minutes, "minutes") ?? 10;
        if (minutes <= 0) throw new CliError("--minutes: must be above 0");
        const { workers } = readWorkersSection();
        try {
          const r = await calibrate({ minutes, load: ctx.opts.load === true }, liveGateDeps(out), () => localBusyReason(workersLogDir(workers), workers.providers));
          const cal = saveCalibration(r.mode, r.pctPerHour);
          out(`${r.mode} rate: ${r.pctPerHour > 0 ? "+" : ""}${r.pctPerHour} %/h (${r.from} % -> ${r.to} % in ${minutes} min), stored in power.calibration (${cal.measuredAt})`);
          return 0;
        } catch (e) {
          if (e instanceof CalibrateRefused) throw new CliError(e.message, "pai power calibrate --load");
          throw e;
        }
      },
    },
  ],
};
