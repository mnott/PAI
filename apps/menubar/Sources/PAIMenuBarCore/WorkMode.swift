import Foundation

/// `pai worker mode speed|balanced|budget|local`.
public enum WorkMode: String, CaseIterable, Sendable {
    case speed, balanced, budget, local
    public var label: String { rawValue.capitalized }
    public var tooltip: String {
        switch self {
        case .speed: return "Speed: cloud first"
        case .balanced: return "Balanced: local first, cloud while under pace"
        case .budget: return "Budget: local only where possible"
        case .local: return "Local: everything local, cloud only as takeover"
        }
    }
}

/// The rule line under the buttons, e.g. "cloud first for orchestrate, plan: 21% < 80% of pace 34%".
/// `classes` is budget.cloudUnderPace.classes (nil = unknown, keep the old wording).
public func workModeRule(_ mode: WorkMode, used: Double?, pace: Double?, ratio: Double = 0.8, classes: [String]? = nil) -> String {
    switch mode {
    case .speed: return "cloud first: speed mode"
    case .budget: return "local only where possible: budget mode"
    case .local: return "everything local, cloud only as takeover: local mode"
    case .balanced:
        guard let used, let pace else { return "local first: no weekly pace reading" }
        let r = "\(Int((ratio * 100).rounded()))%"
        let scope = classes?.isEmpty == false ? " for \(classes!.joined(separator: ", "))" : ""
        return used < ratio * pace
            ? "cloud first\(scope): \(Int(used.rounded()))% < \(r) of pace \(Int(pace.rounded()))%"
            : "local first: \(Int(used.rounded()))% >= \(r) of pace \(Int(pace.rounded()))%"
    }
}

/// Mode from `pai worker mode` output ("mode: balanced — ...").
public func parseWorkMode(_ out: String) -> WorkMode? {
    guard let r = out.range(of: #"mode: (speed|balanced|budget|local)"#, options: .regularExpression) else { return nil }
    return WorkMode(rawValue: String(out[r].dropFirst(6)))
}

public enum WorkModeCLI {
    static let candidates = ["/usr/local/bin/pai", "/opt/homebrew/bin/pai", NSHomeDirectory() + "/.local/bin/pai"]
    public static func run(_ args: [String]) -> String? {
        guard let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return nil }
        return PowerSystem.run(path, ["worker", "mode"] + args)
    }
}
