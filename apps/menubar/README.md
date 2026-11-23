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
3. The app is ad-hoc signed, not notarized: open it the first time with right-click, Open. Or remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/PAI.app`.

## Requirements

macOS 13 or newer and a running PAI router: `http://127.0.0.1:8790`, or a tailnet host
(Settings, add host). The endpoint list is described under Endpoints below.

## Build and run


    ./build.sh            # produces build/PAI.app (LSUIElement, no Dock icon)
    open build/PAI.app
    ./package.sh          # release zip: build/PAI-MenuBar-<version>.zip (ad-hoc signed)
    swift test            # decodes synthetic fixtures with the same shape as the live router

## Configure

Default router URL is `http://127.0.0.1:8790`. Change it via "Settings…" in the
popover (stored in UserDefaults, key `pai.baseURL`), e.g. the tailnet host on
VPN. When unreachable the popover shows "cannot reach <url>".

Refresh: every 2.5 s while the popover is open, every 15 s while closed.

## Endpoints

The app tries `127.0.0.1:8790`, then this Mac's tailnet name (read at runtime
from `tailscale status --json`), then hosts added in Settings; the first that
answers is used, and it re-detects when the current one stops answering. The
queue payload carries `machine` (normal / frozen / deep-frozen); the header
card drives `POST /cockpit/queue/act` with `all:true` (freeze, thaw,
deep-freeze, deep-resume).
