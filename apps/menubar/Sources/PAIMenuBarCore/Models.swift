import Foundation

// Decoded router payloads. Everything non-essential is optional so unknown or
// missing fields never break a refresh.

public struct LimitsResponse: Codable {
    public struct Window: Codable {
        public var name: String?
        public var percent: Double?
        public var resetAt: Double? // ms epoch
        public var pace: Double?    // elapsed share of the window, percent
    }
    public struct Limit: Codable {
        public var provider: String?
        public var kind: String?
        public var windows: [Window]?
        public var error: String?
        public var up: Bool?
        public var served: [String]?
        public var speed: Speed?
        public var instances: [Instance]?
    }
    public struct Instance: Codable {
        public var id: String?
        public var inflight: Double?
    }
    public struct Speed: Codable {
        public var prefillTps: Double?
        public var decodeTps: Double?
    }
    public var now: Double?
    public var limits: [Limit]?
    /// The router's pace decision (`pace: currentPace()` on /cockpit/limits); `classes` = budget.cloudUnderPace.classes.
    public var pace: Pace?

    public struct Pace: Codable {
        public var cloud: Bool?
        public var reason: String?
        public var classes: [String]?
    }

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
        /// battery history only: true while the charge was rising on AC
        public var charging: Bool?
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
        public var topic: String?
        public var level: Int?
        public var local: Bool?

        enum CodingKeys: String, CodingKey {
            case slot, kind, id, state, stateText, priority, session, model, instance
            case task, activity, now, seconds, summary, actions, topic, level, local
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
            topic = try? c.decodeIfPresent(String.self, forKey: .topic)
            level = try? c.decodeIfPresent(Int.self, forKey: .level)
            local = try? c.decodeIfPresent(Bool.self, forKey: .local)
        }
    }
    public struct Inst: Codable {
        public var engine: String?
        public var busy: Int?
        public var cap: Int?
    }
    public struct Provider: Codable {
        public var provider: String?
        public var cap: Int?
        public var instances: [Inst]?
    }
    public struct Machine: Codable {
        public var state: String?
        public var since: Double?
        public var until: Double?
    }
    public var table: [Row]?
    public var providers: [Provider]?
    public var machine: Machine?

    public struct InstanceStat: Equatable {
        public var label: String, busy: Int, cap: Int
    }

    /// Per-instance busy/cap of a local provider ("signal-2#2" -> "#2", plain -> "#1").
    public func instanceStats(provider: String) -> [InstanceStat] {
        guard let ins = (providers ?? []).first(where: { $0.provider == provider })?.instances else { return [] }
        return ins.map { i in
            let n = (i.engine ?? "").split(separator: "#").dropFirst().first.map(String.init) ?? "1"
            return InstanceStat(label: "#" + n, busy: i.busy ?? 0, cap: i.cap ?? 0)
        }
    }

    /// "#1 1/2 · #2 0/2"
    public func instanceSummary(provider: String) -> String? {
        let st = instanceStats(provider: provider)
        return st.isEmpty ? nil : st.map { "\($0.label) \($0.busy)/\($0.cap)" }.joined(separator: " · ")
    }

    /// Jobs running or queued on a local provider's instances.
    public func busyTotal(provider: String) -> Int? {
        guard let ins = (providers ?? []).first(where: { $0.provider == provider })?.instances, !ins.isEmpty else { return nil }
        return ins.reduce(0) { $0 + ($1.busy ?? 0) }
    }

    /// Session -> hue, no two shown sessions sharing one.
    public func sessionHues() -> [String: Double] {
        assignHues(jobs().map { $0.session ?? "unknown" })
    }

    /// Job rows that are running, waiting, paused or frozen.
    public func jobs() -> [Row] {
        (table ?? []).filter { $0.kind == "job" && ["running", "waiting", "paused", "frozen", "deep-frozen"].contains($0.state ?? "") }
    }

    public struct Section {
        public var name: String, state: String, rows: [Row]
    }

    /// Running / Waiting / Paused sections (frozen rows count as paused); rows
    /// keep queue order, clustered by session (first appearance).
    public func sections(rows: [Row]? = nil) -> [Section] {
        let all = rows ?? jobs()
        func cluster(_ r: [Row]) -> [Row] {
            var order: [String] = []
            for x in r { let k = x.session ?? "unknown"; if !order.contains(k) { order.append(k) } }
            return order.flatMap { k in r.filter { ($0.session ?? "unknown") == k } }
        }
        return [("Running", "running"), ("Waiting", "waiting"), ("Paused", "paused")].map { name, st in
            let m = all.filter { st == "paused" ? !["running", "waiting"].contains($0.state ?? "") : $0.state == st }
            return Section(name: name, state: st, rows: cluster(m))
        }
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

/// Model chip text: local "signal-2 #1", cloud "cloud: sonnet" (with the up arrow).
public func modelChipText(_ r: QueueResponse.Row) -> String {
    let m = r.model ?? "?"
    if r.local == false { return "↑ " + (m.hasPrefix("cloud") ? m : "cloud: " + m) }
    return r.instance ?? m
}

public func topicChipText(_ t: String) -> String { t.count > 16 ? String(t.prefix(15)) + "…" : t }

/// "decode 39 t/s" from the live reading, else the last non-zero one, else "—".
public func speedText(_ label: String, live: Double?, last: Double?) -> String {
    if let live, live > 0 { return "\(label) \(Int(live)) t/s" }
    if let last, last > 0 { return "\(label) \(Int(last)) t/s" }
    return "\(label) —"
}

/// A local engine is idle when nothing runs on its instances.
public func localIdle(limit: LimitsResponse.Limit, busy: Int?) -> Bool {
    if let busy { return busy == 0 }
    if let inst = limit.instances, !inst.isEmpty { return inst.allSatisfy { ($0.inflight ?? 0) == 0 } }
    return (limit.speed?.decodeTps ?? 0) == 0
}

/// Case-insensitive match on task, session, topic and model chip text.
public func filterJobs(_ rows: [QueueResponse.Row], query: String) -> [QueueResponse.Row] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty else { return rows }
    return rows.filter { r in
        [r.task, r.session, r.topic, modelChipText(r)].compactMap { $0?.lowercased() }.contains { $0.contains(q) }
    }
}

/// One dim line under a job title: what the worker is doing (writing / tool / thinking / waiting) and the current tool excerpt; nil when idle data is missing.
public func activityLine(_ r: QueueResponse.Row) -> String? {
    let word = (r.activity ?? "").trimmingCharacters(in: .whitespaces)
    let now = (r.now ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
    let clipped = now.count > 80 ? String(now.prefix(79)) + "…" : now
    switch (word.isEmpty, clipped.isEmpty) {
    case (true, true): return nil
    case (false, true): return word
    case (true, false): return clipped
    default: return word + " · " + clipped
    }
}

/// Reroute entries for a job's context menu: (label, action) for what its action list offers, with the current target.
public func rerouteItems(_ r: QueueResponse.Row) -> [(label: String, action: String)] {
    let a = r.actions ?? []
    let target = r.local == false ? "cloud" : "local"
    var out: [(label: String, action: String)] = []
    if a.contains("to-cloud") { out.append(("Run on cloud (now \(target))", "to-cloud")) }
    if a.contains("to-local") { out.append(("Run locally (now \(target))", "to-local")) }
    return out
}

/// Machine state badge: "normal", "frozen since 14:05", "deep-frozen".
public func machineBadge(_ m: QueueResponse.Machine?, timeZone: TimeZone = .current) -> String {
    switch m?.state {
    case "frozen":
        guard let since = m?.since else { return "frozen" }
        let f = DateFormatter(); f.dateFormat = "HH:mm"; f.timeZone = timeZone
        return "frozen since " + f.string(from: Date(timeIntervalSince1970: since / 1000))
    case "deep-frozen": return "deep-frozen"
    default: return "normal"
    }
}

/// POST body for the machine-wide controls: freeze (optional duration), thaw, deep-freeze, deep-resume.
public func machineActionRequest(baseURL: URL, action: String, forMs: Double? = nil) -> URLRequest {
    var req = URLRequest(url: baseURL.appendingPathComponent("cockpit/queue/act"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    var body: [String: Any] = ["action": action, "all": true]
    if let forMs { body["forMs"] = forMs }
    req.httpBody = try! JSONSerialization.data(withJSONObject: body)
    return req
}

/// The last `minutes` of a series (by t, ms), or everything when too short.
public func tailSeries(_ s: [SystemResponse.Sample], minutes: Double = 6) -> [SystemResponse.Sample] {
    guard let last = s.compactMap(\.t).max() else { return s }
    let t = s.filter { ($0.t ?? 0) >= last - minutes * 60_000 }
    return t.count >= 2 ? t : s
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

/// Everything one local runtime row shows: its own activity line ("idle" when
/// nothing runs) and its own slot lines. Slots come from the queue's provider
/// entry, else from the runtime's own instances, so a runtime the queue does not
/// list still gets its line.
public struct EngineLines: Equatable {
    public var idle: Bool
    public var slots: [QueueResponse.InstanceStat]
}

public func engineLines(limit: LimitsResponse.Limit, queue: QueueResponse?) -> EngineLines {
    let provider = limit.provider ?? ""
    var slots = queue?.instanceStats(provider: provider) ?? []
    if slots.isEmpty {
        slots = (limit.instances ?? []).map { i in
            let n = (i.id ?? "").split(separator: "#").dropFirst().first.map(String.init) ?? "1"
            return .init(label: "#" + n, busy: Int(i.inflight ?? 0), cap: 1)
        }
    }
    return EngineLines(idle: localIdle(limit: limit, busy: queue?.busyTotal(provider: provider)), slots: slots)
}
