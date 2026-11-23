# PAI menu bar app

Native macOS menu bar app (SwiftUI `MenuBarExtra`, macOS 13+, no dependencies)
showing the cockpit essentials: cloud limits, system stats, local model stats
and running/waiting jobs (pause/continue, stop, priority).

Data comes from the router's cockpit endpoints (`/cockpit/limits`, `/system`,
`/queue`, `/data`, POST `/cockpit/queue/act`).

![PAI menu bar popover](docs/screenshot.png) <!-- screenshot placeholder -->

## What it shows

- Cloud limits per provider with a pace needle
- System: CPU, GPU, SoC temperature, power and memory, each with a live sparkline, plus a CPU/GPU area chart; the history grows with every poll
- Local models: prefill and decode t/s, time to first token, per-instance slots
- Running, waiting and paused jobs with pause/continue, stop and priority; machine freeze and thaw

## Install

1. Download `PAI-MenuBar-<version>.zip` from the GitHub release of PAI.
2. Unzip it and move `PAI.app` to `/Applications`.
3. Release builds are Developer ID signed and notarized: no further steps.

Self-built copies (`./package.sh` without `PAI_SIGN_IDENTITY`) are ad-hoc signed and not notarized: open them the first time with right-click, Open, or remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/PAI.app`.

Release signing: set `PAI_SIGN_IDENTITY` (a `Developer ID Application: ...` identity) and `PAI_NOTARY_PROFILE` (a `notarytool store-credentials` keychain profile) before `pai build run -- ./package.sh`; it signs with the hardened runtime, notarizes, staples, re-zips and verifies with `spctl` and `stapler validate`.

## Requirements

macOS 13 or newer and a running PAI router: `http://127.0.0.1:8790`, or a tailnet host
(Settings, add host). The endpoint list is described under Endpoints below.

## Build and run


    ./build.sh            # produces build/PAI.app (LSUIElement, no Dock icon)
    open build/PAI.app
    ./package.sh          # release zip: build/PAI-MenuBar-<version>.zip (Developer ID + notarized with the env vars, else ad-hoc)
    swift test            # decodes synthetic fixtures with the same shape as the live router

## Configure

Default router URL is `http://127.0.0.1:8790`. Change it via "Settings…" in the
popover (stored in UserDefaults, key `pai.baseURL`), e.g. the tailnet host on
VPN. When unreachable the popover shows "cannot reach <url>".

Refresh: every 2.5 s while the popover is open, every 15 s while closed.

## Power mode and battery

The machine row has Power: Low / Auto / High (the active source's mode, read with
`pmset -g custom`). Click asks for your admin password through the system prompt
(AppleScript, nothing stored); a declined prompt shows the error inline.

Optional: Settings, "Switch power mode without asking" (off by default). Turning it on
asks for admin once and writes `/etc/sudoers.d/pai-powermode` with exactly three
lines allowing your user to run `/usr/bin/pmset -a powermode 0`, `1` and `2` without a
password (written to a temp file, checked with `visudo -cf`, installed 0440 root:wheel).
The app then runs `sudo -n /usr/bin/pmset -a powermode N`; if that fails it falls back
to the prompt. Turning the setting off removes the file (one admin prompt). The sudoers
rule is the interim mechanism for the ad-hoc signed build; with a Developer ID signed,
notarised app it moves to an SMAppService privileged helper (approved once in System
Settings > Login Items & Extensions).

On Macs with a battery, a Battery row sits under CPU: charge over time (same window as
CPU), charging state, current draw and the runtime at current usage (remaining Wh from
`ioreg` divided by the draw smoothed over ~90 s, e.g. "2h 10m at 35 W"); macOS's own
estimate is shown only as a labelled fallback. Hidden without a battery.

## Endpoints

The app tries `127.0.0.1:8790`, then this Mac's tailnet name (read at runtime
from `tailscale status --json`), then hosts added in Settings; the first that
answers is used, and it re-detects when the current one stops answering. The
queue payload carries `machine` (normal / frozen / deep-frozen); the header
card drives `POST /cockpit/queue/act` with `all:true` (freeze, thaw,
deep-freeze, deep-resume).
