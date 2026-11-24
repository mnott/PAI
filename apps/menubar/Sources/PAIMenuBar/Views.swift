import SwiftUI
import AppKit
import PAIMenuBarCore

// MARK: colours (cockpit palette, light and dark menu bar appearance)

extension Color {
    /// Dynamic colour: the hex of the current appearance.
    init(_ pair: Pair) {
        self.init(nsColor: NSColor(name: nil) { ap in
            let dark = ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let c = rgb(hex: pair.hex(dark: dark))
            return NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1)
        })
    }

    init(_ light: HSLA, dark: HSLA) {
        self.init(nsColor: NSColor(name: nil) { ap in
            let isDark = ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let c = rgb(isDark ? dark : light)
            return NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a)
        })
    }
}

struct Chip: View {
    var text: String
    var hue: Double
    var topic = false
    var model = false
    var body: some View {
        let l = chipColors(hue: hue, dark: false, topic: topic, model: model)
        let d = chipColors(hue: hue, dark: true, topic: topic, model: model)
        Text(text)
            .font(.system(size: topic ? 9 : 10))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .foregroundStyle(Color(l.text, dark: d.text))
            .background(Capsule().fill(Color(l.fill, dark: d.fill)))
            .overlay(Capsule().strokeBorder(Color(l.border, dark: d.border),
                                            style: StrokeStyle(lineWidth: 1, dash: topic ? [2, 2] : [])))
            .fixedSize()
    }
}

struct Dot: View {
    var pair: Pair
    var body: some View { Circle().fill(Color(pair)).frame(width: 7, height: 7) }
}

/// Rounded section card like the reference design.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 4) { content }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .labelColor).opacity(0.06)))
    }
}

// MARK: charts

/// Sparkline from a series of numbers, tinted per metric.
struct Sparkline: View {
    var values: [Double]
    var tint: Pair
    var body: some View {
        GeometryReader { geo in
            Path { p in
                guard values.count > 1 else { return }
                let lo = values.min()!, hi = max(values.max()!, lo + 1)
                for (i, v) in values.enumerated() {
                    let x = geo.size.width * Double(i) / Double(values.count - 1)
                    let y = geo.size.height * (1 - (v - lo) / (hi - lo))
                    if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
                }
            }
            .stroke(Color(tint), lineWidth: 1.5)
        }
        .frame(height: 14)
    }
}

/// Bar with an optional pace needle (elapsed share of the window).
struct Gauge: View {
    var percent: Double
    var pace: Double? = nil
    var tint: Pair
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color(nsColor: .labelColor).opacity(0.12))
                Capsule().fill(Color(tint)).frame(width: g.size.width * min(max(percent, 0), 100) / 100)
                if let pace {
                    Rectangle().fill(Color(nsColor: .labelColor)).frame(width: 2, height: g.size.height + 4)
                        .offset(x: g.size.width * min(max(pace, 0), 100) / 100 - 1)
                }
            }
        }
        .frame(height: 6)
    }
}

// MARK: metrics

struct MetricRow: View {
    var label: String
    var value: String
    var tint: Pair
    var spark: [Double] = []
    var detail: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
                Dot(pair: tint)
                Text(label).font(.caption2).foregroundStyle(.secondary).frame(width: 50, alignment: .leading)
                Group {
                    if spark.count > 1 { Sparkline(values: spark, tint: tint) } else { Color.clear.frame(height: 14) }
                }
                .frame(maxWidth: .infinity)
                Text(value).font(.caption.monospacedDigit()).foregroundStyle(Color(tint))
                    .lineLimit(1).frame(width: 110, alignment: .trailing)
            }
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).padding(.leading, 62)
            }
        }
    }
}

struct SystemCard: View {
    var sys: SystemResponse?
    var history: [SystemResponse.Sample]
    var battery: BatteryInfo? = nil
    var batteryHistory: [SystemResponse.Sample] = []
    var batteryDetail: String? = nil
    var powerMode: PowerMode = .auto
    var aneWatts: Double? = nil
    var aneHistory: [Double] = []
    var aneInflight = 0
    @Binding var message: String?
    var body: some View {
        Card {
            if let c = sys?.current {
                let s = tailSeries(history)
                MetricRow(label: "CPU", value: "\(Int(c.cpu ?? 0))%", tint: Palette.cpu, spark: s.compactMap(\.cpu))
                MetricRow(label: "GPU", value: "\(Int(c.gpu ?? 0))%", tint: Palette.gpu, spark: s.compactMap(\.gpu))
                MetricRow(label: "ANE", value: aneWatts.map { String(format: "%.1f W", $0) } ?? "n/a", tint: Palette.ane,
                          spark: Array(aneHistory.suffix(60)),
                          detail: aneWatts == nil ? "IOReport unreadable; apple-fm in flight: \(aneInflight)" : nil)
                if let battery {
                    MetricRow(label: "Battery", value: "\(Int(battery.percent))%", tint: Palette.ok)
                    BatteryChart(history: batteryHistory, caption: batteryDetail ?? "")
                    PowerModeBar(powerMode: powerMode, message: $message)
                }
                MetricRow(label: "SoC", value: String(format: "%.1f°C", c.socTemp ?? 0), tint: Palette.soc, spark: s.compactMap(\.socTemp))
                MetricRow(label: "Power", value: String(format: "%.0f W", c.systemW ?? c.totalW ?? 0), tint: Palette.power, spark: s.compactMap(\.systemW))
                MetricRow(label: "Mem", value: "\(Int((c.memUsed ?? 0) / 1e9))/\(Int((c.memTotal ?? 0) / 1e9)) GB · L\(Int(c.pressureLevel ?? 0))", tint: Palette.mem, spark: s.compactMap(\.memPct))
                MetricRow(label: "Swap", value: "\(Int((c.swapUsed ?? 0) / 1e9))/\(Int((c.swapTotal ?? 0) / 1e9)) GB", tint: Palette.swap)
            } else {
                Text("no system data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: limits and local engines

struct LimitsCard: View {
    var limits: LimitsResponse?
    var queue: QueueResponse?
    var data: DataResponse?
    var speeds: [String: LimitsResponse.Speed] = [:]
    var workMode: WorkMode? = nil
    var workRule: String? = nil
    @Binding var message: String?
    var body: some View {
        Card {
            WorkModeBar(mode: workMode, rule: workRule, message: $message)
            if let limits {
                ForEach(limits.activeCloud(), id: \.provider) { l in
                    Chip(text: "↑ cloud: \(l.provider ?? "?")", hue: modelHue(model: l.provider ?? "", local: false), model: true)
                    ForEach(l.windows ?? [], id: \.name) { w in
                        let pct = w.percent ?? 0
                        HStack(spacing: 6) {
                            Text(w.name ?? "").font(.caption2).foregroundStyle(.secondary).frame(width: 26, alignment: .leading)
                            Gauge(percent: pct, pace: w.pace, tint: Palette.gauge(percent: pct)).frame(width: 110)
                            Text("\(Int(pct))%").font(.caption2.monospacedDigit()).foregroundStyle(Color(Palette.gauge(percent: pct)))
                            if let p = w.pace { Text("pace \(Int(p))%").font(.caption2).foregroundStyle(.secondary) }
                            if let r = w.resetAt, let n = limits.now {
                                Text(formatReset(now: n, resetAt: r)).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                ForEach(limits.localUp(), id: \.provider) { l in
                    LocalEngine(limit: l, queue: queue, data: data, speeds: speeds)
                }
            } else {
                Text("no limits data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct LocalEngine: View {
    var limit: LimitsResponse.Limit
    var queue: QueueResponse?
    var data: DataResponse?
    var speeds: [String: LimitsResponse.Speed] = [:]
    var body: some View {
        let provider = limit.provider ?? ""
        let name = limit.served?.first ?? provider
        let lines = engineLines(limit: limit, queue: queue)
        let stats = lines.slots
        let idle = lines.idle
        let ttft = data?.ttft(provider: provider) ?? (nil, nil)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Chip(text: provider, hue: localHue, model: true)
                Text(name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            if idle {
                Text("idle").font(.caption2).foregroundStyle(Color(Palette.dim))
            } else {
                HStack(spacing: 8) {
                    Text(speedText("prefill", live: limit.speed?.prefillTps, last: speeds[provider]?.prefillTps)).font(.caption2.monospacedDigit())
                    Text(speedText("decode", live: limit.speed?.decodeTps, last: speeds[provider]?.decodeTps)).font(.caption2.monospacedDigit())
                    Text("ttft \(formatTTFT(ms: ttft.0))").font(.caption2).foregroundStyle(.secondary)
                }
            }
            ForEach(Array(stats.enumerated()), id: \.offset) { i, s in
                HStack(spacing: 4) {
                    Text(i == stats.count - 1 ? "└" : "├").font(.caption2).foregroundStyle(.secondary)
                    Dot(pair: s.busy > 0 ? Palette.ok : Palette.dim)
                    Text("\(s.label) \(s.busy)/\(s.cap)").font(.caption2.monospacedDigit())
                }.padding(.leading, 8)
            }
        }
    }
}

// MARK: jobs

struct JobRow: View {
    var row: QueueResponse.Row
    var hues: [String: Double]
    var baseURL: URL
    @Binding var expandedId: String?
    @Binding var message: String?
    @State private var confirmStop = false

    struct ActionButton { var label: String; var action: String; var confirm: Bool }

    func actionButtons() -> [ActionButton] {
        let a = row.actions ?? []
        var out: [ActionButton] = []
        if a.contains("pause") { out.append(.init(label: "pause", action: "pause", confirm: false)) }
        if a.contains("resume") || (a.contains("start-now") && row.state == "paused") {
            out.append(.init(label: "resume", action: "start-now", confirm: false))
        }
        if a.contains("stop") || a.contains("kill") { out.append(.init(label: "stop", action: "stop", confirm: true)) }
        for p in ["prio-low", "prio-normal", "prio-high", "prio-now"] where a.contains(p) {
            out.append(.init(label: String(p.dropFirst(5)), action: p, confirm: false))
        }
        return out
    }

    var body: some View {
        let session = row.session ?? "unknown"
        let level = row.level == 1 ? 1 : 2
        VStack(alignment: .leading, spacing: 2) {
            Button {
                expandedId = (expandedId == row.id) ? nil : row.id
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Dot(pair: Palette.state(row.state))
                        Text("L\(level)").font(.system(size: 9, weight: level == 1 ? .semibold : .regular))
                            .padding(.horizontal, 4)
                            .foregroundStyle(level == 1 ? Color(Palette.acc) : .secondary)
                            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(level == 1 ? Color(Palette.acc) : Color.secondary.opacity(0.4)))
                        Text(row.task ?? row.id ?? "?").font(.caption).lineLimit(1).help(row.summary ?? "")
                        Spacer(minLength: 4)
                        Text(formatElapsed(seconds: row.seconds ?? 0)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    if let line = activityLine(row) {
                        Text(line).font(.caption2).foregroundStyle(.secondary).opacity(0.7).lineLimit(1)
                            .padding(.leading, 12)
                    }
                    HStack(spacing: 4) {
                        Chip(text: session, hue: hues[session] ?? hue(for: session))
                        if let t = row.topic, !t.isEmpty { Chip(text: topicChipText(t), hue: hue(for: "topic:" + t), topic: true) }
                        Chip(text: modelChipText(row), hue: modelHue(model: row.model ?? "", local: row.local != false), model: true)
                    }
                    .padding(.leading, 12)
                }
            }
            .buttonStyle(.plain)
            .contextMenu {
                ForEach(rerouteItems(row), id: \.action) { item in
                    Button(item.label) {
                        Task { message = await Store.shared.performAction(baseURL: baseURL, id: row.id ?? "", action: item.action) }
                    }
                }
            }

            if expandedId == row.id {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.now ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    HStack(spacing: 6) {
                        ForEach(actionButtons(), id: \.action) { act in
                            Button(act.label) {
                                if act.confirm { confirmStop = true }
                                else { Task { message = await Store.shared.performAction(baseURL: baseURL, id: row.id ?? "", action: act.action) } }
                            }
                            .controlSize(.mini)
                        }
                    }
                }
                .padding(.leading, 12)
                .confirmationDialog("Stop \(row.task ?? "job")?", isPresented: $confirmStop, titleVisibility: .visible) {
                    Button("Stop", role: .destructive) {
                        Task { message = await Store.shared.performAction(baseURL: baseURL, id: row.id ?? "", action: "stop") }
                    }
                }
            }
        }
    }
}

struct QueueCard: View {
    var queue: QueueResponse?
    var search: String
    var baseURL: URL
    @Binding var expandedId: String?
    @Binding var message: String?
    @State private var showAll = false
    static let limit = 8

    /// Rows shown per section when at most `limit` rows are shown in total.
    func visibleRows(_ secs: [QueueResponse.Section], limit: Int) -> [[QueueResponse.Row]] {
        var left = limit
        return secs.map { sec in
            let r = Array(sec.rows.prefix(max(left, 0)))
            left -= r.count
            return r
        }
    }

    var body: some View {
        Card {
            if let queue {
                let filtered = filterJobs(queue.jobs(), query: search)
                let secs = queue.sections(rows: filtered)
                let hues = queue.sessionHues()
                let shownRows = visibleRows(secs, limit: showAll ? Int.max : Self.limit)
                ForEach(Array(secs.enumerated()), id: \.offset) { idx, sec in
                    let shown = shownRows[idx]
                    HStack(spacing: 5) {
                        Dot(pair: Palette.state(sec.state))
                        Text("\(sec.name) \(sec.rows.count)").font(.caption.bold())
                            .foregroundStyle(sec.rows.isEmpty ? Color.secondary.opacity(0.6) : Color.primary)
                    }
                    ForEach(shown, id: \.id) { row in
                        JobRow(row: row, hues: hues, baseURL: baseURL, expandedId: $expandedId, message: $message)
                    }
                }
                let total = filtered.count
                if !showAll && total > Self.limit {
                    Button("Show more… (\(total - Self.limit))") { showAll = true }
                        .controlSize(.small).buttonStyle(.bordered)
                } else if showAll && total > Self.limit {
                    Button("Show less") { showAll = false }.controlSize(.small).buttonStyle(.bordered)
                }
            } else {
                Text("no queue data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: battery chart, power and worker mode

/// Filled area of values 0...100 (fixed scale). A flat or single-sample series
/// is drawn as a line, not a block: a filled path with no variation reads as a
/// solid rectangle.
struct Area: Shape {
    var values: [Double]

    /// True when the series has no variation to fill between.
    var flat: Bool { values.count < 2 || Set(values).count <= 1 }

    func path(in r: CGRect) -> Path {
        var p = Path()
        guard values.count > 1 else { return p }
        p.move(to: CGPoint(x: 0, y: r.height))
        for (i, v) in values.enumerated() {
            p.addLine(to: CGPoint(x: r.width * Double(i) / Double(values.count - 1),
                                  y: r.height * (1 - min(max(v, 0), 100) / 100)))
        }
        p.addLine(to: CGPoint(x: r.width, y: r.height))
        p.closeSubpath()
        return p
    }
}

/// Charge % over the same window as the CPU/GPU graphs; charging stretches are marked on the baseline.
struct BatteryChart: View {
    var history: [SystemResponse.Sample]
    var caption: String
    var body: some View {
        let s = tailSeries(history)
        let vals = drawableSeries(s.compactMap(\.memPct))
        let flat = Area(values: vals).flat
        VStack(spacing: 2) {
            ZStack {
                RoundedRectangle(cornerRadius: 4).fill(Color(nsColor: .labelColor).opacity(0.05))
                if !flat { Area(values: vals).fill(Color(Palette.ok).opacity(0.45)) }
                Area(values: vals).stroke(Color(Palette.ok), lineWidth: flat ? 1.5 : 1)
                GeometryReader { g in
                    ForEach(Array(chargingRuns(s).enumerated()), id: \.offset) { _, r in
                        let n = Double(max(s.count - 1, 1))
                        Rectangle().fill(Color(Palette.acc))
                            .frame(width: max(2, g.size.width * Double(r.count - 1) / n), height: 3)
                            .offset(x: g.size.width * Double(r.lowerBound) / n, y: g.size.height - 3)
                    }
                }
            }
            .frame(height: 44)
            Text(caption).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    /// Index ranges of consecutive charging samples.
    func chargingRuns(_ s: [SystemResponse.Sample]) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var start: Int?
        for (i, x) in s.enumerated() {
            if x.charging == true { if start == nil { start = i } }
            else if let st = start { out.append(st..<i); start = nil }
        }
        if let st = start { out.append(st..<s.count) }
        return out
    }
}

struct PowerModeBar: View {
    var powerMode: PowerMode
    @Binding var message: String?
    var body: some View {
        HStack(spacing: 4) {
            Text("Power").font(.caption2).foregroundStyle(.secondary)
            ForEach(PowerMode.allCases, id: \.rawValue) { m in
                Button(m.label) {
                    Task {
                        let r = await Store.shared.setPowerMode(m, viaPrompt: PowerPrompt.setMode)
                        message = r.isEmpty ? nil : r
                    }
                }
                .buttonStyle(.bordered).tint(m == powerMode ? Color(Palette.acc) : nil)
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(m == powerMode ? Color(Palette.acc) : .clear))
            }
            Spacer()
        }
        .controlSize(.small)
    }
}

struct WorkModeBar: View {
    var mode: WorkMode?
    var rule: String?
    @Binding var message: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text("Workers").font(.caption2).foregroundStyle(.secondary)
                ForEach(WorkMode.allCases, id: \.rawValue) { m in
                    Button(m.label) { Task { message = await Store.shared.setWorkMode(m) } }
                        .buttonStyle(.bordered).tint(m == mode ? Color(Palette.acc) : nil)
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(m == mode ? Color(Palette.acc) : .clear))
                        .help(m.tooltip)
                }
                Spacer()
            }
            .controlSize(.small)
            if let rule { Text(rule).font(.caption2).foregroundStyle(.secondary) }
        }
    }
}

// MARK: machine controls

struct MachineBar: View {
    var machine: QueueResponse.Machine?
    var baseURL: URL
    @Binding var message: String?
    @State private var armed: String?
    @State private var duration: Double = 0 // minutes, 0 = until thawed

    func run(_ action: String, forMs: Double? = nil) {
        armed = nil
        Task { message = await Store.shared.performMachine(baseURL: baseURL, action: action, forMs: forMs) }
    }

    var body: some View {
        let state = machine?.state ?? "normal"
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(machineBadge(machine)).font(.caption2.bold())
                    .padding(.horizontal, 7)
                    .foregroundStyle(Color(state == "normal" ? Palette.ok : state == "frozen" ? Palette.acc : Palette.deep))
                    .background(Capsule().fill(Color(state == "normal" ? Palette.ok : state == "frozen" ? Palette.acc : Palette.deep).opacity(0.16)))
                    .overlay(Capsule().strokeBorder(Color(state == "normal" ? Palette.ok : state == "frozen" ? Palette.acc : Palette.deep)))
                Spacer()
                if state == "normal" {
                    Picker("", selection: $duration) {
                        Text("until thaw").tag(0.0); Text("15m").tag(15.0); Text("30m").tag(30.0); Text("1h").tag(60.0)
                    }.labelsHidden().frame(width: 90).controlSize(.mini)
                    Button("Freeze") { run("freeze", forMs: duration > 0 ? duration * 60_000 : nil) }
                } else if state == "frozen" {
                    Button("Thaw") { run("thaw") }
                }
                if state == "deep-frozen" {
                    Button("Resume") { run("deep-resume") }
                } else if armed == "deep-freeze" {
                    Button("Confirm deep freeze") { run("deep-freeze") }.tint(.red)
                    Button("Cancel") { armed = nil }
                } else {
                    Button("Deep freeze") { armed = "deep-freeze" }
                        .help("WIP-commit and stop everything; survives a reboot")
                }
            }
            .controlSize(.small)
        }
    }
}

/// Reports the view's measured height; used to keep the popover window matched
/// to the content's ideal height.
struct HeightReader: View {
    var onChange: (CGFloat) -> Void
    var body: some View {
        GeometryReader { geo in
            Color.clear.onAppear { onChange(geo.size.height) }
                .onChange(of: geo.size.height) { onChange($0) }
        }
    }
}

// MARK: popover

struct PopoverContent: View {
    @ObservedObject var store: Store
    @ObservedObject var endpoints: EndpointManager
    @State private var expandedId: String?
    @State private var message: String?
    @State private var search = ""
    @Binding var visible: Bool

    init(store: Store, endpoints: EndpointManager, visible: Binding<Bool>) {
        self.store = store; self.endpoints = endpoints; _visible = visible
    }

    var body: some View {
        let base = endpoints.baseURL
        let running = (store.queue?.jobs() ?? []).filter { $0.state == "running" }.count
        VStack(alignment: .leading, spacing: 8) {
            // header: icon, status, search
            HStack(spacing: 8) {
                Image(nsImage: makeMenuBarIcon()).renderingMode(.template)
                Text("PAI").font(.headline)
                Text(store.error != nil ? "offline" : "\(running) running")
                    .font(.caption).foregroundStyle(store.error != nil ? Color(Palette.bad) : Color(Palette.ok))
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: "magnifyingglass").font(.caption).foregroundStyle(.secondary)
                    TextField("Search jobs", text: $search).textFieldStyle(.plain).font(.caption).frame(width: 110)
                }
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .labelColor).opacity(0.08)))
            }
            if let err = store.error {
                Text(err).font(.caption).foregroundStyle(Color(Palette.bad))
                if let age = store.staleLine() { Text(age).font(.caption2).foregroundStyle(.secondary) }
            }
            Card { MachineBar(machine: store.queue?.machine, baseURL: base, message: $message) }
            LimitsCard(limits: store.limits, queue: store.queue, data: store.data, speeds: store.lastSpeed,
                       workMode: store.workMode, workRule: store.workMode.map { workModeRule($0, used: store.weeklyPace()?.used, pace: store.weeklyPace()?.pace, classes: store.paceClasses()) }, message: $message)
            SystemCard(sys: store.system, history: store.history, battery: store.battery, batteryHistory: store.batteryHistory,
                       batteryDetail: store.batteryDetail(), powerMode: store.powerMode,
                       aneWatts: store.aneWatts, aneHistory: store.aneHistory, aneInflight: store.appleFMInflight(), message: $message)
            QueueCard(queue: store.queue, search: search, baseURL: base, expandedId: $expandedId, message: $message)
            if let message { Text(message).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
            Divider()
            footer(base: base)
        }
        .padding(10)
        .frame(width: 420)
        .onAppear { visible = true; Task { await store.refreshOnOpen(baseURL: base) } }
        .onDisappear { visible = false }
        .background(HeightReader { store.contentIdealHeight = $0 })
    }

    func footer(base: URL) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                legend("Running", Palette.ok)
                legend("Waiting", Palette.warn)
                legend("Paused", Palette.dim)
                Spacer()
                Text("L1 coordinates · L2 works").font(.system(size: 9)).foregroundStyle(.secondary)
                    .help("Level badges: L1 splits the work and checks results, L2 does the work. Chips: session, topic (dashed), model (↑ = cloud).")
            }
            HStack(spacing: 8) {
                Button("Settings…") { NSApp.activate(ignoringOtherApps: true); SettingsWindowController.shared.show() }
                Button("Open cockpit") { NSWorkspace.shared.open(base.appendingPathComponent("cockpit")) }
                Spacer()
                Text(endpoints.active.map { "via \($0.label) · \($0.url.host ?? "")" } ?? "no endpoint answers")
                    .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
            }
            .controlSize(.small)
        }
    }

    func legend(_ text: String, _ pair: Pair) -> some View {
        HStack(spacing: 3) { Dot(pair: pair); Text(text).font(.system(size: 10)).foregroundStyle(.secondary) }
    }
}
