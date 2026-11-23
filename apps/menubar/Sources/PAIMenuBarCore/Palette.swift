import Foundation

// Cockpit palette (src/router/cockpit-page/css.ts and win/cards-workers.ts),
// kept as pure data so the colour rules are unit-testable without AppKit.

public struct HSLA: Equatable {
    public var h: Double, s: Double, l: Double, a: Double
    public init(_ h: Double, _ s: Double, _ l: Double, _ a: Double = 1) { self.h = h; self.s = s; self.l = l; self.a = a }
}

public struct RGBA: Equatable {
    public var r: Double, g: Double, b: Double, a: Double
}

/// h in degrees, s/l in percent.
public func rgb(_ c: HSLA) -> RGBA {
    let s = c.s / 100, l = c.l / 100
    let k = { (n: Double) -> Double in (n + c.h / 30).truncatingRemainder(dividingBy: 12) }
    let a = s * min(l, 1 - l)
    let f = { (n: Double) -> Double in l - a * max(-1, min(k(n) - 3, min(9 - k(n), 1))) }
    return RGBA(r: f(0), g: f(8), b: f(4), a: c.a)
}

public func rgb(hex: String) -> RGBA {
    var v: UInt64 = 0
    Scanner(string: String(hex.drop(while: { $0 == "#" }))).scanHexInt64(&v)
    return RGBA(r: Double((v >> 16) & 255) / 255, g: Double((v >> 8) & 255) / 255, b: Double(v & 255) / 255, a: 1)
}

/// A colour with a light and a dark menu bar variant.
public struct Pair: Equatable {
    public var light: String, dark: String
    public init(_ light: String, _ dark: String) { self.light = light; self.dark = dark }
    public func hex(dark isDark: Bool) -> String { isDark ? dark : light }
}

public enum Palette {
    public static let ok = Pair("#2e9e5b", "#46c47a")
    public static let warn = Pair("#d98a1c", "#e8a43a")
    public static let bad = Pair("#d64545", "#ef6b6b")
    public static let acc = Pair("#3b6fe0", "#6b95f5")
    public static let dim = Pair("#6b7385", "#8b93a7")
    public static let deep = Pair("#9a6bd6", "#9a6bd6")
    // per-metric tints (cockpit --sec-N)
    public static let cpu = Pair("#2f5fa8", "#3b6ab8")
    public static let gpu = Pair("#6b49a8", "#7a57b8")
    public static let soc = Pair("#b3641a", "#bd7125")
    public static let power = Pair("#a63d66", "#b44a74")
    public static let mem = Pair("#23808c", "#2c8c99")
    public static let swap = Pair("#8a7420", "#9a8228")

    public static func state(_ s: String?) -> Pair {
        switch s {
        case "running": return ok
        case "waiting": return warn
        case "deep-frozen": return deep
        default: return dim // paused, frozen
        }
    }

    /// Gauge fill by percent used.
    public static func gauge(percent: Double) -> Pair {
        percent >= 90 ? bad : percent >= 70 ? warn : ok
    }
}

/// The cockpit's 12 session hues; a name takes the slot of its stable hash.
public let sessionHuePalette: [Double] = [5, 28, 48, 85, 140, 170, 190, 210, 240, 270, 300, 330]

public func nameHash(_ n: String) -> Int {
    var h = 0
    for u in n.utf16 { h = (h * 31 + Int(u)) % 9973 }
    return h
}

public func hue(for name: String) -> Double { sessionHuePalette[nameHash(name) % sessionHuePalette.count] }

/// Sessions shown together never share a hue: sorted names take their hash
/// slot, else the next free one (wkAssign).
public func assignHues(_ names: [String]) -> [String: Double] {
    var used = Set<Int>(), out = [String: Double]()
    let n = sessionHuePalette.count
    for name in Set(names).sorted() {
        var k = nameHash(name) % n, tries = 0
        while tries < n && used.contains(k) { k = (k + 1) % n; tries += 1 }
        used.insert(k)
        out[name] = sessionHuePalette[k]
    }
    return out
}

public let localHue: Double = 175 // teal

/// Cloud: opus amber, sonnet violet, haiku, fable, other families. Local: teal.
public func modelHue(model: String, local: Bool) -> Double {
    if local { return localHue }
    if model.contains("opus") { return 40 }
    if model.contains("sonnet") { return 270 }
    if model.contains("haiku") { return 200 }
    if model.contains("fable") { return 320 }
    return 290
}

public struct ChipColors: Equatable {
    public var text: HSLA, border: HSLA, fill: HSLA
}

/// .wq-chip (session, model) and .wq-tp (topic, dashed, transparent fill).
public func chipColors(hue h: Double, dark: Bool, topic: Bool = false, model: Bool = false) -> ChipColors {
    if topic {
        return ChipColors(text: HSLA(h, 30, dark ? 72 : 40), border: HSLA(h, 25, 55), fill: HSLA(h, 25, 50, 0))
    }
    return ChipColors(text: HSLA(h, dark ? 65 : 55, dark ? 70 : 45), border: HSLA(h, 55, 50),
                      fill: HSLA(h, 60, 50, model ? 0.14 : 0.28))
}
