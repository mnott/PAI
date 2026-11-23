import Foundation

// Power mode (Low / Auto / High) and battery readings from pmset and ioreg.
// Parsing and command building are pure and unit-tested; running processes is
// in PowerSystem below.

public enum PowerMode: Int, CaseIterable {
    case auto = 0, low = 1, high = 2
    public var label: String { self == .auto ? "Auto" : self == .low ? "Low" : "High" }
}

/// Active power source from `pmset -g batt` ("Now drawing from 'AC Power'").
public func onBatterySource(pmsetBatt: String) -> Bool {
    pmsetBatt.contains("'Battery Power'")
}

/// Mode of the active source from `pmset -g custom`. Sections are "Battery Power:"
/// and "AC Power:"; `powermode` 1/2 wins, else `lowpowermode 1` means Low.
public func parsePowerMode(pmsetCustom: String, onBattery: Bool) -> PowerMode {
    let want = onBattery ? "Battery Power" : "AC Power"
    var inSection = false
    var power: Int?, low: Int?
    for raw in pmsetCustom.split(separator: "\n") {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasSuffix(":") { inSection = line.dropLast() == want; continue }
        guard inSection else { continue }
        let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard parts.count == 2, let v = Int(parts[1]) else { continue }
        if parts[0] == "powermode" { power = v }
        if parts[0] == "lowpowermode" { low = v }
    }
    if let p = power, let m = PowerMode(rawValue: p), m != .auto { return m }
    return low == 1 ? .low : .auto
}

/// `sudo -n` command that switches the mode without a prompt (needs the sudoers rule).
public func powerModeCommand(_ mode: PowerMode) -> [String] {
    ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-a", "powermode", String(mode.rawValue)]
}

/// Shell command run with administrator privileges for the per-click prompt.
public func powerModeAdminShell(_ mode: PowerMode) -> String {
    "/usr/bin/pmset -a powermode \(mode.rawValue)"
}

public let sudoersPath = "/etc/sudoers.d/pai-powermode"

/// The opt-in sudoers rule: exactly the three pmset commands, nothing else.
public func sudoersText(user: String) -> String {
    (0...2).map { "\(user) ALL=(root) NOPASSWD: /usr/bin/pmset -a powermode \($0)" }.joined(separator: "\n") + "\n"
}

/// Shell script run once with administrator privileges to install the rule:
/// write to a temp file, validate with visudo -cf, move in place 0440 root:wheel.
public func sudoersInstallScript(user: String) -> String {
    let tmp = "/tmp/pai-powermode.sudoers"
    let lines = sudoersText(user: user).split(separator: "\n").map { "printf '%s\\n' '\($0)'" }.joined(separator: "; ")
    return "umask 077; ( \(lines) ) > \(tmp) && /usr/sbin/visudo -cf \(tmp) && /usr/sbin/chown root:wheel \(tmp) && /bin/chmod 0440 \(tmp) && /bin/mv \(tmp) \(sudoersPath) || { /bin/rm -f \(tmp); exit 1; }"
}

public let sudoersRemoveScript = "/bin/rm -f \(sudoersPath)"

public struct BatteryInfo: Equatable {
    public var percent: Double
    public var state: String          // "charging", "discharging", "charged", "ac"
    public var macRemainingMin: Double?
    public var onBattery: Bool
}

/// Parse `pmset -g batt`; nil on Macs without a battery.
public func parseBattery(pmsetBatt: String) -> BatteryInfo? {
    guard let line = pmsetBatt.split(separator: "\n").first(where: { $0.contains("InternalBattery") }) else { return nil }
    let s = String(line)
    guard let r = s.range(of: #"(\d+)%"#, options: .regularExpression),
          let pct = Double(s[r].dropLast()) else { return nil }
    let state: String
    if s.contains("discharging") { state = "discharging" }
    else if s.contains("not charging") { state = "ac" }
    else if s.contains("charged") { state = "charged" }
    else if s.contains("charging") { state = "charging" }
    else { state = "ac" }
    var rem: Double?
    if let m = s.range(of: #"(\d+):(\d+) remaining"#, options: .regularExpression) {
        let p = s[m].split(separator: " ")[0].split(separator: ":")
        if p.count == 2, let h = Double(p[0]), let mi = Double(p[1]) { rem = h * 60 + mi }
    }
    return BatteryInfo(percent: pct, state: state, macRemainingMin: rem, onBattery: onBatterySource(pmsetBatt: pmsetBatt))
}

/// Remaining energy in Wh from `ioreg -rn AppleSmartBattery` (mAh x mV).
public func parseRemainingWh(ioreg: String) -> Double? {
    func num(_ key: String) -> Double? {
        guard let r = ioreg.range(of: "\"\(key)\" = ", options: []) else { return nil }
        let tail = ioreg[r.upperBound...].prefix(while: { $0.isNumber })
        return Double(tail)
    }
    guard let mah = num("AppleRawCurrentCapacity"), let mv = num("Voltage"), mah > 0, mv > 0 else { return nil }
    return mah * mv / 1_000_000
}

/// Smoothed draw (W) over the last `seconds` of live samples (t in ms).
public func smoothedWatts(_ samples: [SystemResponse.Sample], seconds: Double = 90) -> Double? {
    guard let last = samples.compactMap(\.t).max() else { return nil }
    let w = samples.filter { ($0.t ?? 0) >= last - seconds * 1000 }.compactMap(\.systemW)
    return w.isEmpty ? nil : w.reduce(0, +) / Double(w.count)
}

/// "2h 10m at 35 W" (remaining Wh / smoothed draw), else macOS's estimate marked as such.
public func runtimeText(info: BatteryInfo, remainingWh: Double?, watts: Double?) -> String? {
    guard info.state == "discharging" else { return nil }
    if let wh = remainingWh, let w = watts, w >= 1 {
        let mins = Int((wh / w * 60).rounded())
        return "\(mins / 60)h \(String(format: "%02d", mins % 60))m at \(Int(w.rounded())) W"
    }
    if let m = info.macRemainingMin { return "\(Int(m) / 60)h \(String(format: "%02d", Int(m) % 60))m (macOS estimate)" }
    return nil
}

/// Runs the system tools; each call is one short-lived process.
public enum PowerSystem {
    public static func run(_ path: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }

    public struct Reading { public var battery: BatteryInfo?; public var wh: Double?; public var mode: PowerMode }

    public static func read() -> Reading {
        let batt = run("/usr/bin/pmset", ["-g", "batt"]) ?? ""
        let info = parseBattery(pmsetBatt: batt)
        let custom = run("/usr/bin/pmset", ["-g", "custom"]) ?? ""
        let mode = parsePowerMode(pmsetCustom: custom, onBattery: info?.onBattery ?? onBatterySource(pmsetBatt: batt))
        let wh = info == nil ? nil : run("/usr/sbin/ioreg", ["-rn", "AppleSmartBattery"]).flatMap { parseRemainingWh(ioreg: $0) }
        return Reading(battery: info, wh: wh, mode: mode)
    }

    /// True when `sudo -n pmset` is permitted for the mode (rule installed).
    public static func setWithoutPrompt(_ mode: PowerMode) -> Bool {
        let c = powerModeCommand(mode)
        return run(c[0], Array(c.dropFirst())) != nil
    }
}
