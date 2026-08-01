/**
 * schedule-install.ts — install the scheduler tick as a launchd agent
 *
 * Two speeds were considered and rejected in favour of one: a fixed interval.
 * A 15-minute tick is 96 runs a day, each one API call and zero tokens, and
 * daily routines do not need better than 15-minute granularity — a 09:00 sweep
 * starting at 09:12 is fine. Adaptive intervals would add a second thing that
 * can silently stop.
 *
 * StartInterval rather than StartCalendarInterval on purpose: the schedule
 * lives in Todoist, not here. This agent only decides how often to *look*.
 * That means one plist total, however many routines exist, and rescheduling a
 * routine never touches the machine.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const SCHEDULE_LABEL = "com.pai.task-scheduler";
const LAUNCH_AGENTS = join(homedir(), "Library", "LaunchAgents");
export const SCHEDULE_PLIST = join(LAUNCH_AGENTS, `${SCHEDULE_LABEL}.plist`);
export const SCHEDULE_LOG = "/tmp/pai-scheduler.log";

/** Default tick, in seconds. */
export const DEFAULT_INTERVAL_SECS = 900;

function cliPath(): string {
  // dist/cli/index.mjs at runtime
  return fileURLToPath(new URL("index.mjs", import.meta.url));
}

export function generateSchedulePlist(intervalSecs: number, cli: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SCHEDULE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${cli}</string>
        <string>task</string>
        <string>poll</string>
    </array>

    <key>StartInterval</key>
    <integer>${intervalSecs}</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${SCHEDULE_LOG}</string>

    <key>StandardErrorPath</key>
    <string>${SCHEDULE_LOG}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
`;
}

export interface InstallResult {
  plistPath: string;
  intervalSecs: number;
  loaded: boolean;
  message: string;
}

export function installSchedule(intervalSecs = DEFAULT_INTERVAL_SECS): InstallResult {
  if (!existsSync(LAUNCH_AGENTS)) mkdirSync(LAUNCH_AGENTS, { recursive: true });

  const cli = cliPath();
  const plist = generateSchedulePlist(intervalSecs, cli);

  // Plain write: a plist is generated, not user data, so the json-store guard
  // would be the wrong tool — there is nothing here anyone could not regenerate.
  writeFileSync(SCHEDULE_PLIST, plist, "utf8");

  spawnSync("launchctl", ["unload", SCHEDULE_PLIST], { encoding: "utf8" });
  const load = spawnSync("launchctl", ["load", SCHEDULE_PLIST], { encoding: "utf8" });

  return {
    plistPath: SCHEDULE_PLIST,
    intervalSecs,
    loaded: load.status === 0,
    message:
      load.status === 0
        ? `Scheduler installed — ticking every ${Math.round(intervalSecs / 60)} min.`
        : `Plist written but launchctl load failed: ${(load.stderr || "").trim()}`,
  };
}

export function uninstallSchedule(): string {
  if (!existsSync(SCHEDULE_PLIST)) return "Scheduler is not installed.";
  spawnSync("launchctl", ["unload", SCHEDULE_PLIST], { encoding: "utf8" });
  unlinkSync(SCHEDULE_PLIST);
  return "Scheduler uninstalled.";
}

export function scheduleStatus(): { installed: boolean; running: boolean; detail: string } {
  const installed = existsSync(SCHEDULE_PLIST);
  if (!installed) return { installed: false, running: false, detail: "Not installed." };

  const list = spawnSync("launchctl", ["list", SCHEDULE_LABEL], { encoding: "utf8" });
  const running = list.status === 0;
  return {
    installed: true,
    running,
    detail: running
      ? `Loaded. Log: ${SCHEDULE_LOG}`
      : "Plist present but not loaded — run `pai task schedule install` again.",
  };
}
