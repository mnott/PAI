import Foundation

/// Fetches the four cockpit endpoints and holds decoded state.
/// /limits, /system, /queue every tick; /data only every ~15 s (heavy).
@MainActor
public final class Store: ObservableObject {
    @Published public private(set) var limits: LimitsResponse?
    @Published public private(set) var system: SystemResponse?
    @Published public private(set) var queue: QueueResponse?
    @Published public private(set) var data: DataResponse?
    @Published public private(set) var error: String?
    /// What the charts read: the router's bucketed series as seed, then one live sample appended per poll.
    @Published public private(set) var history: [SystemResponse.Sample] = []
    public static let historyCap = 400
    public static let liveMin = 5
    @Published public private(set) var battery: BatteryInfo?
    @Published public private(set) var remainingWh: Double?
    @Published public private(set) var powerMode: PowerMode = .auto
    /// charge % over time (t in ms), same window as the CPU chart
    @Published public private(set) var batteryHistory: [SystemResponse.Sample] = []
    /// Neural Engine power (W), read from IOReport; nil when unreadable.
    @Published public private(set) var aneWatts: Double?
    @Published public private(set) var aneHistory: [Double] = []
    public let aneReader = ANEReader()
    @Published public private(set) var workMode: WorkMode?
    /// Measured ideal height of the popover content; drives the window height.
    @Published public var contentIdealHeight: Double = 0
    private var seedCount = 0
    /// Last non-zero decode/prefill reading per local provider: the router reports 0/null
    /// between measurements while requests are still in flight.
    @Published public private(set) var lastSpeed: [String: LimitsResponse.Speed] = [:]

    private let session: URLSession
    private var lastDataFetch = Date.distantPast
    /// Start of the latest poll (any trigger) and the latest poll that succeeded.
    public private(set) var lastPoll = Date.distantPast
    @Published public private(set) var lastSuccess: Date?
    public static let openDebounce: TimeInterval = 1

    public init(session: URLSession = .shared) { self.session = session }

    /// Poll everything right away when the popover opens. Skipped when a poll started under 1 s ago
    /// (quick open/close/open). Returns whether a poll ran.
    @discardableResult
    public func refreshOnOpen(baseURL: URL, now: Date = Date()) async -> Bool {
        guard now.timeIntervalSince(lastPoll) >= Store.openDebounce else { return false }
        await refresh(baseURL: baseURL, forceData: true)
        await loadWorkMode()
        return true
    }

    private var inFlight = false
    public static let openInterval: TimeInterval = 1
    public static let closedInterval: TimeInterval = 15

    /// One poll at a time: a tick that finds the previous poll still running is skipped.
    public func refresh(baseURL: URL, forceData: Bool = false) async {
        guard !inFlight else { return }
        inFlight = true
        lastPoll = Date()
        defer { inFlight = false; lastPoll = Date() }
        let heavyDue = forceData || Date().timeIntervalSince(lastDataFetch) > 15
        if heavyDue { lastDataFetch = Date() }
        do {
            async let l: LimitsResponse = get("cockpit/limits", baseURL)
            async let s: SystemResponse = get("cockpit/system", baseURL)
            async let q: QueueResponse = get("cockpit/queue", baseURL)
            let (lv, sv, qv) = try await (l, s, q)
            limits = lv; system = sv; queue = qv
            ingest(system: sv)
            ingest(limits: lv)
            let r = await Task.detached { PowerSystem.read() }.value
            ingest(power: r)
            let reader = aneReader
            ingest(ane: await Task.detached { reader.read() }.value)
            if heavyDue, let d: DataResponse = try? await get("cockpit/data?window=1h", baseURL) { data = d }
            error = nil
            lastSuccess = Date()
        } catch {
            self.error = "cannot reach \(baseURL.absoluteString)"
        }
    }

    /// The router's series is 5-minute buckets, so it barely moves between polls.
    /// Seed history from it once, then append the live reading of every poll.
    public func ingest(system sv: SystemResponse) {
        let now = sv.now ?? Date().timeIntervalSince1970 * 1000
        if history.isEmpty {
            history = (sv.series?.series ?? []).filter { ($0.t ?? 0) < now }
            seedCount = history.count
        }
        if let c = sv.current {
            let memPct = (c.memTotal ?? 0) > 0 ? (c.memUsed ?? 0) / (c.memTotal ?? 1) * 100 : nil
            let t = max(now, (history.last?.t ?? 0) + 1)
            history.append(.init(t: t, cpu: c.cpu, gpu: c.gpu, socTemp: c.socTemp, systemW: c.systemW ?? c.totalW, memPct: memPct))
            // once enough live samples exist the coarse seed buckets only distort the time axis
            if seedCount > 0, history.count - seedCount >= Store.liveMin { history.removeFirst(seedCount); seedCount = 0 }
            if history.count > Store.historyCap { history.removeFirst(history.count - Store.historyCap) }
        }
    }

    public func ingest(ane w: Double?) {
        aneWatts = w
        guard let w else { return }
        aneHistory.append(w)
        if aneHistory.count > Store.historyCap { aneHistory.removeFirst(aneHistory.count - Store.historyCap) }
    }

    /// In-flight requests on the apple-fm engine: the ANE activity stand-in when IOReport is unreadable.
    public func appleFMInflight() -> Int {
        let l = limits?.limits?.first { $0.provider == "apple-fm" }
        return Int((l?.instances ?? []).reduce(0) { $0 + ($1.inflight ?? 0) })
    }

    public func ingest(power r: PowerSystem.Reading, now: Double = Date().timeIntervalSince1970 * 1000) {
        battery = r.battery; remainingWh = r.wh; powerMode = r.mode
        guard let b = r.battery else { batteryHistory = []; return }
        batteryHistory.append(.init(t: now, memPct: b.percent, charging: b.state == "charging"))
        if batteryHistory.count > Store.historyCap { batteryHistory.removeFirst(batteryHistory.count - Store.historyCap) }
    }

    /// "updated 12 s ago" for stale data after a failed poll; nil when there is nothing to say.
    public func staleLine(now: Date = Date()) -> String? {
        guard error != nil, let t = lastSuccess else { return nil }
        let s = max(0, Int(now.timeIntervalSince(t)))
        return s < 60 ? "updated \(s) s ago" : "updated \(s / 60) min ago"
    }

    /// Secondary text under the battery row: state and runtime at the current draw.
    public func batteryDetail() -> String? {
        guard let b = battery else { return nil }
        return batteryCaption(info: b, remainingWh: remainingWh, watts: smoothedWatts(history))
    }

    /// Text under the battery graph: state, draw, runtime at current usage.
    public func batteryLine() -> String {
        guard let b = battery else { return "" }
        let w = smoothedWatts(history)
        var parts = ["\(Int(b.percent))%", b.state == "ac" ? "on AC" : b.state]
        if let w { parts.append("\(Int(w.rounded())) W") }
        if let rt = runtimeText(info: b, remainingWh: remainingWh, watts: w) { parts.append(rt) }
        return parts.joined(separator: " · ")
    }

    public func loadWorkMode() async {
        let out = await Task.detached { WorkModeCLI.run([]) }.value
        if let out, let m = parseWorkMode(out) { workMode = m }
    }

    /// Returns an error message, nil on success.
    public func setWorkMode(_ m: WorkMode) async -> String? {
        let out = await Task.detached { WorkModeCLI.run([m.rawValue]) }.value
        guard out != nil else { return "pai worker mode failed" }
        workMode = m
        return nil
    }

    /// The classes the under-pace cloud lead applies to (budget.cloudUnderPace.classes), nil when the router sent none.
    public func paceClasses() -> [String]? { limits?.pace?.classes }

    /// Weekly cloud window (used %, pace %) of the first cloud provider that has one.
    public func weeklyPace() -> (used: Double, pace: Double)? {
        for l in limits?.activeCloud() ?? [] {
            if let w = l.windows?.first(where: { $0.name == "7d" }), let p = w.percent, let pace = w.pace { return (p, pace) }
        }
        return nil
    }

    public func setPowerMode(_ mode: PowerMode, viaPrompt: (PowerMode) -> String?) async -> String {
        let quiet = await Task.detached { PowerSystem.setWithoutPrompt(mode) }.value
        if !quiet, let err = viaPrompt(mode) { return err }
        powerMode = mode
        return ""
    }

    public func ingest(limits lv: LimitsResponse) {
        for l in lv.localUp() {
            guard let p = l.provider, let sp = l.speed else { continue }
            var kept = lastSpeed[p] ?? .init()
            if (sp.decodeTps ?? 0) > 0 { kept.decodeTps = sp.decodeTps }
            if (sp.prefillTps ?? 0) > 0 { kept.prefillTps = sp.prefillTps }
            lastSpeed[p] = kept
        }
    }

    public func performAction(baseURL: URL, id: String, action: String) async -> String {
        do {
            let (data, _) = try await session.data(for: actionRequest(baseURL: baseURL, id: id, action: action))
            if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return (obj["message"] as? String) ?? ((obj["ok"] as? Bool) == true ? "ok" : "failed")
            }
            return "failed"
        } catch {
            return "error: \(error.localizedDescription)"
        }
    }

    public func performMachine(baseURL: URL, action: String, forMs: Double? = nil) async -> String {
        do {
            let (data, _) = try await session.data(for: machineActionRequest(baseURL: baseURL, action: action, forMs: forMs))
            if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return (obj["message"] as? String).map { String($0.split(separator: "\n").last ?? "") } ?? ((obj["ok"] as? Bool) == true ? "ok" : "failed")
            }
            return "failed"
        } catch {
            return "error: \(error.localizedDescription)"
        }
    }

    private func get<T: Decodable>(_ path: String, _ base: URL) async throws -> T {
        let (body, _) = try await session.data(from: base.appendingPathComponent(path))
        return try JSONDecoder().decode(T.self, from: body)
    }
}
