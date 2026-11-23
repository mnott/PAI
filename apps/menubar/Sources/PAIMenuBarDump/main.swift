import Foundation
import PAIMenuBarCore

// Headless check of the data layer: fetches the live router endpoints and
// prints the four panels as the popover would show them.
// Usage: PAIMenuBarDump [baseURL]
let base = URL(string: CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:8790")!

@MainActor func run() async {
    let store = Store()
    await store.refresh(baseURL: base, forceData: true)
    if let e = store.error { print(e); exit(1) }

    print("== Cloud limits")
    for l in store.limits?.activeCloud() ?? [] {
        for w in l.windows ?? [] {
            let reset = formatReset(now: store.limits?.now ?? 0, resetAt: w.resetAt ?? 0)
            print("\(l.provider ?? "?") \(w.name ?? "?") \(Int(w.percent ?? 0))% \(reset)")
        }
    }
    print("== System")
    let c = store.system?.current
    print("mem \(c?.memUsed ?? 0)/\(c?.memTotal ?? 0) swap \(c?.swapUsed ?? 0) wired \(c?.wired ?? 0) compressed \(c?.compressed ?? 0)")
    print("gpu \(c?.gpu ?? 0)% cpu \(c?.cpu ?? 0)% soc \(c?.socTemp ?? 0)C power \(c?.systemW ?? 0)W samples \(store.system?.series?.series?.count ?? 0)")
    print("== Local models")
    for l in store.limits?.localUp() ?? [] {
        let t = store.data?.ttft(provider: l.provider ?? "") ?? (nil, nil)
        print("\(l.served?.first ?? l.provider ?? "?") ttft \(formatTTFT(ms: t.0)) p90 \(formatTTFT(ms: t.1)) decode \(Int(l.speed?.decodeTps ?? 0)) prefill \(Int(l.speed?.prefillTps ?? 0))")
    }
    print("== Jobs")
    for g in store.queue?.groupedBySession() ?? [] {
        print(g.session)
        for r in g.rows {
            print("  \(r.slot ?? "") \(r.state ?? "") \(r.task ?? "") \(r.model ?? "")\(r.instance.map { " #" + $0 } ?? "") \(formatElapsed(seconds: r.seconds ?? 0))")
        }
    }
    let running = (store.queue?.jobs() ?? []).filter { $0.slot == "running" }.count
    print("title: \(menuTitle(running: running, gpu: c?.gpu))")
    exit(0)
}
Task { await run() }
RunLoop.main.run()
