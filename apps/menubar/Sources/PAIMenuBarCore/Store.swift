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
            if heavyDue, let d: DataResponse = try? await get("cockpit/data?window=1h", baseURL) { data = d }
            error = nil
        } catch {
            self.error = "cannot reach \(baseURL.absoluteString)"
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
