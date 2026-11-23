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
    private var seedCount = 0
    /// Last non-zero decode/prefill reading per local provider: the router reports 0/null
    /// between measurements while requests are still in flight.
    @Published public private(set) var lastSpeed: [String: LimitsResponse.Speed] = [:]

    private let session: URLSession
    private var lastDataFetch = Date.distantPast

    public init(session: URLSession = .shared) { self.session = session }

    public func refresh(baseURL: URL, forceData: Bool = false) async {
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
            if heavyDue, let d: DataResponse = try? await get("cockpit/data?window=1h", baseURL) { data = d }
            error = nil
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
