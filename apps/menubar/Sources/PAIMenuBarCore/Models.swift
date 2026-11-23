import Foundation

// Decoded router payloads. Everything non-essential is optional so unknown or
// missing fields never break a refresh.

public struct LimitsResponse: Codable {
    public struct Window: Codable {
        public var name: String?
        public var percent: Double?
        public var resetAt: Double? // ms epoch
    }
    public struct Limit: Codable {
        public var provider: String?
        public var kind: String?
        public var windows: [Window]?
        public var error: String?
        public var up: Bool?
        public var served: [String]?
        public var speed: Speed?
    }
    public struct Speed: Codable {
        public var prefillTps: Double?
        public var decodeTps: Double?
    }
    public var now: Double?
    public var limits: [Limit]?

    /// Cloud providers worth showing: not local, no error, at least one window.
    public func activeCloud() -> [Limit] {
        (limits ?? []).filter {
            $0.kind != "local" && ($0.error ?? "").isEmpty && !( $0.windows ?? []).isEmpty
        }
    }

    /// Local engines that are up, for the model-stats card.
    public func localUp() -> [Limit] {
        (limits ?? []).filter { $0.kind == "local" && $0.up == true }
    }
}

public struct SystemResponse: Codable {
    public struct Current: Codable {
        public var cpu: Double?
        public var gpu: Double?
        public var socTemp: Double?
        public var systemW: Double?
        public var totalW: Double?
        public var memTotal: Double?
        public var memUsed: Double?
        public var wired: Double?
        public var compressed: Double?
        public var swapTotal: Double?
        public var swapUsed: Double?
        public var pressureLevel: Double?
    }
    public struct Sample: Codable {
        public var t: Double?
        public var cpu: Double?
        public var gpu: Double?
        public var socTemp: Double?
        public var systemW: Double?
        public var memPct: Double?
    }
    public struct Series: Codable {
        public var series: [Sample]?
    }
    public var now: Double?
    public var current: Current?
    public var series: Series?
}

public struct QueueResponse: Codable {
    public struct Row: Codable {
        public var slot: String?
        public var kind: String?
        public var id: String?
        public var state: String?
        public var stateText: String?
        public var priority: String?
        public var session: String?
        public var model: String?
        public var instance: String?
        public var task: String?
        public var activity: String?
        public var now: String?
        public var seconds: Double?
        public var summary: String?
        public var actions: [String]?

        enum CodingKeys: String, CodingKey {
            case slot, kind, id, state, stateText, priority, session, model, instance
            case task, activity, now, seconds, summary, actions
        }

        /// `slot` is "running" or a queue position number; keep it a string.
        public init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            if let s = try? c.decodeIfPresent(String.self, forKey: .slot) { slot = s }
            else if let n = try? c.decodeIfPresent(Int.self, forKey: .slot) { slot = String(n) }
            kind = try? c.decodeIfPresent(String.self, forKey: .kind)
            id = try? c.decodeIfPresent(String.self, forKey: .id)
            state = try? c.decodeIfPresent(String.self, forKey: .state)
            stateText = try? c.decodeIfPresent(String.self, forKey: .stateText)
            priority = try? c.decodeIfPresent(String.self, forKey: .priority)
            session = try? c.decodeIfPresent(String.self, forKey: .session)
            model = try? c.decodeIfPresent(String.self, forKey: .model)
            instance = try? c.decodeIfPresent(String.self, forKey: .instance)
            task = try? c.decodeIfPresent(String.self, forKey: .task)
            activity = try? c.decodeIfPresent(String.self, forKey: .activity)
            now = try? c.decodeIfPresent(String.self, forKey: .now)
            seconds = try? c.decodeIfPresent(Double.self, forKey: .seconds)
            summary = try? c.decodeIfPresent(String.self, forKey: .summary)
            actions = try? c.decodeIfPresent([String].self, forKey: .actions)
        }
    }
    public var table: [Row]?

    /// Only job rows that are running or waiting (slot is "running" or a number).
    public func jobs() -> [Row] {
        (table ?? []).filter { $0.kind == "job" && ($0.slot == "running" || Int($0.slot ?? "") != nil) }
    }

    /// Job rows grouped by session, sessions sorted alphabetically.
    public func groupedBySession() -> [(session: String, rows: [Row])] {
        let rows = jobs()
        var by = Dictionary(grouping: rows) { $0.session ?? "unknown" }
        return by.keys.sorted().map { ($0, by[$0]!) }
    }
}

public struct DataResponse: Codable {
    public struct Bucket: Codable {
        public var ttftP50: Double?
        public var ttftP90: Double?
    }
    public struct Entry: Codable {
        public var provider: String?
        public var model: String?
        public var h1: Bucket?
        public var h24: Bucket?
    }
    public var speed: [Entry]?

    /// TTFT (ms) for a provider: h1 when present, else h24.
    public func ttft(provider: String) -> (p50: Double?, p90: Double?) {
        guard let e = (speed ?? []).first(where: { $0.provider == provider }) else { return (nil, nil) }
        let use = (e.h1?.ttftP50 != nil || e.h1?.ttftP90 != nil) ? e.h1 : e.h24
        return (use?.ttftP50, use?.ttftP90)
    }
}

// Pure formatting helpers (unit-tested).

public func formatReset(now: Double, resetAt: Double) -> String {
    let secs = max(0, (resetAt - now) / 1000)
    let days = Int(secs / 86400), hours = Int(secs.truncatingRemainder(dividingBy: 86400) / 3600)
    return "resets in \(days)d \(hours)h"
}

public func formatElapsed(seconds: Double) -> String {
    let s = max(0, Int(seconds))
    if s < 60 { return "\(s)s" }
    let m = s / 60
    if m < 60 { return "\(m)m" }
    return "\(m / 60)h\(String(format: "%02d", m % 60))"
}

public func formatTTFT(ms: Double?) -> String {
    guard let ms else { return "—" }
    return String(format: "%.1fs", ms / 1000)
}

/// Menu bar title: running count and GPU percent, e.g. "3▸ GPU 100%".
public func menuTitle(running: Int, gpu: Double?) -> String {
    var s = "\(running)▸"
    if let gpu { s += " GPU \(Int(gpu.rounded()))%" }
    return s
}

/// POST body for /cockpit/queue/act. Kill uses the router's "stop" name.
public func actionRequest(baseURL: URL, id: String, action: String) -> URLRequest {
    var req = URLRequest(url: baseURL.appendingPathComponent("cockpit/queue/act"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try! JSONEncoder().encode(["action": action, "id": id])
    return req
}
