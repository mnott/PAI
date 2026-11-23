import Foundation

/// Joules for an IOReport energy reading in the given unit label ("mJ", "uJ", "nJ", "J").
public func joules(_ value: Double, unit: String) -> Double? {
    switch unit {
    case "J": return value
    case "mJ": return value * 1e-3
    case "uJ", "\u{b5}J", "\u{3bc}J": return value * 1e-6
    case "nJ": return value * 1e-9
    default: return nil
    }
}

/// Average power (W) from an energy delta over an interval.
public func energyToWatts(delta: Double, unit: String, seconds: Double) -> Double? {
    guard seconds > 0, delta >= 0, let j = joules(delta, unit: unit) else { return nil }
    return j / seconds
}

/// True when an IOReport channel name belongs to a given power reader: the ANE reader
/// matches names starting with "ANE"; the GPU/CPU readers match "GPU"/"CPU" prefixes.
public func channelMatches(_ name: String, prefix: String) -> Bool {
    name.hasPrefix(prefix)
}

/// Neural Engine power read in-process from IOReport ("Energy Model" group): the energy
/// counter delta between two calls, divided by the interval. No sudo, no spawned process.
/// `read()` returns nil on the first call (it only primes) and whenever IOReport is unreadable.
public final class ANEReader: @unchecked Sendable {
    private typealias CopyChannels = @convention(c) (CFString, CFString?, UInt64, UInt64, UInt64) -> Unmanaged<CFMutableDictionary>?
    private typealias CreateSub = @convention(c) (UnsafeRawPointer?, CFMutableDictionary, UnsafeMutablePointer<Unmanaged<CFMutableDictionary>?>?, UInt64, CFTypeRef?) -> UnsafeRawPointer?
    private typealias CreateSamples = @convention(c) (UnsafeRawPointer, CFMutableDictionary?, CFTypeRef?) -> Unmanaged<CFDictionary>?
    private typealias CreateDelta = @convention(c) (CFDictionary, CFDictionary, CFTypeRef?) -> Unmanaged<CFDictionary>?
    private typealias Iterate = @convention(c) (CFDictionary, @convention(block) (CFDictionary) -> Int32) -> Void
    private typealias ChannelStr = @convention(c) (CFDictionary) -> Unmanaged<CFString>?
    private typealias IntValue = @convention(c) (CFDictionary, Int32) -> Int64

    private var createSamples: CreateSamples?
    private var createDelta: CreateDelta?
    private var iterate: Iterate?
    private var name: ChannelStr?
    private var unit: ChannelStr?
    private var intValue: IntValue?
    private var sub: UnsafeRawPointer?
    private var channels: CFMutableDictionary?
    private var prev: CFDictionary?
    private var prevAt = Date.distantPast
    public private(set) var available = false
    /// Channel names the subscription matched, e.g. ["ANE Energy", "GPU Energy"]:
    /// lets a dump tool show that the reader's prefix match actually found channels.
    public private(set) var matchedChannels: [String] = []

    public init() {
        guard let h = dlopen("/usr/lib/libIOReport.dylib", RTLD_NOW) else { return }
        func sym<T>(_ n: String, _ t: T.Type) -> T? { dlsym(h, n).map { unsafeBitCast($0, to: t) } }
        guard let copy = sym("IOReportCopyChannelsInGroup", CopyChannels.self),
              let create = sym("IOReportCreateSubscription", CreateSub.self),
              let cs = sym("IOReportCreateSamples", CreateSamples.self),
              let cd = sym("IOReportCreateSamplesDelta", CreateDelta.self),
              let it = sym("IOReportIterate", Iterate.self),
              let nm = sym("IOReportChannelGetChannelName", ChannelStr.self),
              let un = sym("IOReportChannelGetUnitLabel", ChannelStr.self),
              let iv = sym("IOReportSimpleGetIntegerValue", IntValue.self),
              let ch = copy("Energy Model" as CFString, nil, 0, 0, 0)?.takeRetainedValue() else { return }
        var subbed: Unmanaged<CFMutableDictionary>?
        guard let s = create(nil, ch, &subbed, 0, nil) else { return }
        subbed?.release()
        createSamples = cs; createDelta = cd; iterate = it; name = nm; unit = un; intValue = iv
        sub = s; channels = ch; available = true
        var names: [String] = []
        iterate?(ch) { item in
            if let n = name?(item)?.takeUnretainedValue() as String? { names.append(n) }
            return 0
        }
        matchedChannels = names
    }

    /// ANE watts since the previous call; nil when priming or unreadable.
    public func read() -> Double? {
        guard available, let sub, let channels, let createSamples, let createDelta, let iterate, let name, let unit, let intValue,
              let cur = createSamples(sub, channels, nil)?.takeRetainedValue() else { return nil }
        let now = Date()
        defer { prev = cur; prevAt = now }
        guard let prev, let delta = createDelta(prev, cur, nil)?.takeRetainedValue() else { return nil }
        var watts = 0.0, found = false
        let secs = now.timeIntervalSince(prevAt)
        iterate(delta) { item in
            guard let n = name(item)?.takeUnretainedValue() as String?, n.hasPrefix("ANE"),
                  let u = unit(item)?.takeUnretainedValue() as String?,
                  let w = energyToWatts(delta: Double(intValue(item, 0)), unit: u, seconds: secs) else { return 0 }
            watts += w; found = true
            return 0
        }
        return found ? watts : nil
    }
}
