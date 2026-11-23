import SwiftUI
import AppKit
import PAIMenuBarCore

/// Sparkline from a series of numbers (Path, normalized to the range).
struct Sparkline: View {
    var values: [Double]
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
            .stroke(.secondary, lineWidth: 1.5)
        }
        .frame(height: 14)
    }
}

struct MetricRow: View {
    var label: String
    var value: String
    var spark: [Double] = []
    var body: some View {
        HStack(spacing: 6) {
            Text(label).font(.caption2).foregroundStyle(.secondary).frame(width: 58, alignment: .leading)
            Text(value).font(.caption.monospacedDigit())
            Spacer()
            if spark.count > 1 { Sparkline(values: spark).frame(width: 70) }
        }
    }
}

struct LimitsCard: View {
    var limits: LimitsResponse?
    var data: DataResponse?
    var body: some View {
        Group {
            if let limits {
                ForEach(limits.activeCloud(), id: \.provider) { l in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(l.provider ?? "?").font(.caption.bold())
                        ForEach(l.windows ?? [], id: \.name) { w in
                            HStack(spacing: 6) {
                                Text(w.name ?? "").font(.caption2).foregroundStyle(.secondary).frame(width: 30, alignment: .leading)
                                ProgressView(value: min(max(w.percent ?? 0, 0), 100), total: 100).frame(width: 90)
                                Text("\(Int(w.percent ?? 0))%").font(.caption2.monospacedDigit())
                                if let r = w.resetAt, let n = limits.now {
                                    Text(formatReset(now: n, resetAt: r)).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                ForEach(limits.localUp(), id: \.provider) { l in
                    let name = l.served?.first ?? l.provider ?? "?"
                    let ttft = data?.ttft(provider: l.provider ?? "") ?? (nil, nil)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(name).font(.caption.bold())
                        HStack(spacing: 8) {
                            Text("prefill \(Int(l.speed?.prefillTps ?? 0)) t/s").font(.caption2.monospacedDigit())
                            Text("decode \(Int(l.speed?.decodeTps ?? 0)) t/s").font(.caption2.monospacedDigit())
                            Text("ttft \(formatTTFT(ms: ttft.0)) / p90 \(formatTTFT(ms: ttft.1))").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text("no limits data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct SystemCard: View {
    var sys: SystemResponse?
    var body: some View {
        Group {
            if let c = sys?.current {
                let s = (sys?.series?.series ?? []).compactMap { $0 }
                MetricRow(label: "CPU", value: "\(Int(c.cpu ?? 0))%", spark: s.compactMap(\.cpu))
                MetricRow(label: "GPU", value: "\(Int(c.gpu ?? 0))%", spark: s.compactMap(\.gpu))
                MetricRow(label: "SoC", value: String(format: "%.1f°C", c.socTemp ?? 0), spark: s.compactMap(\.socTemp))
                MetricRow(label: "Power", value: String(format: "%.0f W", c.systemW ?? c.totalW ?? 0), spark: s.compactMap(\.systemW))
                MetricRow(label: "Mem", value: "\(Int((c.memUsed ?? 0) / 1e9))/\(Int((c.memTotal ?? 0) / 1e9)) GB · L\(Int(c.pressureLevel ?? 0))", spark: s.compactMap(\.memPct))
                MetricRow(label: "Wired", value: "\(Int((c.wired ?? 0) / 1e9)) GB")
                MetricRow(label: "Compressed", value: "\(Int((c.compressed ?? 0) / 1e9)) GB")
                MetricRow(label: "Swap", value: "\(Int((c.swapUsed ?? 0) / 1e9))/\(Int((c.swapTotal ?? 0) / 1e9)) GB")
            } else {
                Text("no system data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct JobRow: View {
    var row: QueueResponse.Row
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
        VStack(alignment: .leading, spacing: 2) {
            Button {
                expandedId = (expandedId == row.id) ? nil : row.id
            } label: {
                HStack(spacing: 6) {
                    Circle().fill(row.state == "running" ? Color.green : Color.orange).frame(width: 6, height: 6)
                    Text(row.task ?? row.id ?? "?").font(.caption).lineLimit(1)
                        .help(row.summary ?? "")
                    if let inst = row.instance { Text(inst).font(.caption2).foregroundStyle(.secondary) }
                    Spacer()
                    Text(formatElapsed(seconds: row.seconds ?? 0)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

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
    var baseURL: URL
    @Binding var expandedId: String?
    @Binding var message: String?
    var body: some View {
        Group {
            if let queue {
                ForEach(queue.groupedBySession(), id: \.session) { group in
                    Text(group.session).font(.caption.bold()).foregroundStyle(.secondary)
                    ForEach(group.rows, id: \.id) { row in
                        JobRow(row: row, baseURL: baseURL, expandedId: $expandedId, message: $message)
                    }
                }
            } else {
                Text("no queue data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct PopoverContent: View {
    var store: Store
    var baseURL: URL
    @State private var expandedId: String?
    @State private var message: String?
    @Binding var visible: Bool

    public init(store: Store, baseURL: URL, visible: Binding<Bool>) {
        self.store = store; self.baseURL = baseURL; _visible = visible
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = store.error {
                Text(err).font(.caption).foregroundStyle(.red)
            }
            LimitsCard(limits: store.limits, data: store.data)
            Divider()
            SystemCard(sys: store.system)
            Divider()
            QueueCard(queue: store.queue, baseURL: baseURL, expandedId: $expandedId, message: $message)
            if let message { Text(message).font(.caption2).foregroundStyle(.secondary) }
            HStack {
                Button("Settings…") { openSettings() }
                Spacer()
            }
        }
        .padding(10)
        .frame(width: 380)
        .onAppear { visible = true; Task { await store.refresh(baseURL: baseURL, forceData: true) } }
        .onDisappear { visible = false }
    }

    private func openSettings() {
        NSApp.activate(ignoringOtherApps: true)
        SettingsWindowController.shared.show()
    }
}
