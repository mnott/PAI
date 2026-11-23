import Foundation

// Router endpoint detection, mirroring PAILot: an ordered candidate list
// (local first, then the tailnet host of this Mac, then user-added hosts);
// the first one that answers is used, and the choice is re-evaluated when it
// stops answering.

public let defaultPort = 8790

public struct Candidate: Equatable {
    public var label: String
    public var url: URL
}

/// "host", "host:port" or a full URL -> base URL. Empty/invalid -> nil.
public func normalizeHost(_ raw: String, port: Int = defaultPort) -> URL? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while s.hasSuffix("/") || s.hasSuffix(".") { s.removeLast() }
    guard !s.isEmpty else { return nil }
    if !s.contains("://") { s = "http://" + s }
    guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty else { return nil }
    if c.port == nil { c.port = port }
    c.path = ""; c.query = nil; c.fragment = nil
    return c.url
}

/// MagicDNS name of this Mac from `tailscale status --json` (Self.DNSName).
public func parseTailnetHost(json: Data) -> String? {
    guard let o = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
          let me = o["Self"] as? [String: Any],
          var n = me["DNSName"] as? String else { return nil }
    while n.hasSuffix(".") { n.removeLast() }
    return n.isEmpty ? nil : n
}

/// Ordered, de-duplicated candidates: loopback, tailnet host, then extras.
public func buildCandidates(tailnetHost: String?, extras: [String], port: Int = defaultPort) -> [Candidate] {
    var out: [Candidate] = []
    func add(_ label: String, _ u: URL?) {
        guard let u, !out.contains(where: { $0.url == u }) else { return }
        out.append(Candidate(label: label, url: u))
    }
    add("local", normalizeHost("127.0.0.1", port: port))
    if let t = tailnetHost { add("tailnet", normalizeHost(t, port: port)) }
    for e in extras { add(normalizeHost(e, port: port)?.host ?? e, normalizeHost(e, port: port)) }
    return out
}

/// First candidate the probe accepts, in order.
public func pickEndpoint(_ candidates: [Candidate], probe: (URL) async -> Bool) async -> Candidate? {
    for c in candidates where await probe(c.url) { return c }
    return nil
}

/// Reads the tailnet name by running the tailscale CLI (no host is hard-coded).
public func detectTailnetHost() -> String? {
    let paths = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale",
                 "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
    for p in paths where FileManager.default.isExecutableFile(atPath: p) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: p)
        proc.arguments = ["status", "--json"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        guard (try? proc.run()) != nil else { continue }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        if let h = parseTailnetHost(json: data) { return h }
    }
    return nil
}

public func probeRouter(_ base: URL, session: URLSession = .shared) async -> Bool {
    var req = URLRequest(url: base.appendingPathComponent("cockpit/limits"), timeoutInterval: 1.5)
    req.httpMethod = "GET"
    guard let (_, resp) = try? await session.data(for: req), let h = resp as? HTTPURLResponse else { return false }
    return (200..<300).contains(h.statusCode)
}

/// Holds the chosen endpoint and re-detects when it stops answering.
@MainActor
public final class EndpointManager: ObservableObject {
    @Published public private(set) var active: Candidate?
    @Published public private(set) var candidates: [Candidate] = []
    @Published public var extras: [String] {
        didSet { UserDefaults.standard.set(extras, forKey: "pai.extraHosts") }
    }
    private var tailnet: String?
    private var tailnetLooked = false
    private var lastCheck = Date.distantPast

    public init() {
        extras = UserDefaults.standard.stringArray(forKey: "pai.extraHosts") ?? []
    }

    public var baseURL: URL { active?.url ?? URL(string: "http://127.0.0.1:\(defaultPort)")! }

    /// Pick the first answering candidate. Called on start, when the current
    /// one fails, and every 30 s while a lower-priority one is in use.
    public func detect() async {
        lastCheck = Date()
        if !tailnetLooked {
            tailnetLooked = true
            tailnet = await Task.detached { detectTailnetHost() }.value
        }
        candidates = buildCandidates(tailnetHost: tailnet, extras: extras)
        if let c = await pickEndpoint(candidates, probe: { await probeRouter($0) }) { active = c }
        else { active = nil }
    }

    /// Call before each refresh; re-detects when needed.
    public func ensure(failing: Bool) async {
        let notFirst = active != nil && active != candidates.first
        if active == nil || failing || (notFirst && Date().timeIntervalSince(lastCheck) > 30) {
            await detect()
        }
    }

    public func extrasChanged() { Task { await detect() } }
}
