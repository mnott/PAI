# PAI menu bar app

Native macOS menu bar app (SwiftUI `MenuBarExtra`, macOS 13+, no dependencies)
showing the cockpit essentials: cloud limits, system stats, local model stats
and running/waiting jobs (pause/continue, stop, priority).

Data comes from the router's cockpit endpoints (`/cockpit/limits`, `/system`,
`/queue`, `/data`, POST `/cockpit/queue/act`).

## Build and run

    ./build.sh            # produces build/PAI.app (LSUIElement, no Dock icon)
    open build/PAI.app
    swift test            # decodes fixtures captured from the live router

## Configure

Default router URL is `http://127.0.0.1:8790`. Change it via "Settings…" in the
popover (stored in UserDefaults, key `pai.baseURL`), e.g. the tailnet host on
VPN. When unreachable the popover shows "cannot reach <url>".

Refresh: every 2.5 s while the popover is open, every 15 s while closed.
