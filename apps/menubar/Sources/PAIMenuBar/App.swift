import SwiftUI
import AppKit
import PAIMenuBarCore

extension Store {
    static let shared = Store()
}

extension EndpointManager {
    static let shared = EndpointManager()
}

/// Settings window opened from the popover; brought to front despite LSUIElement.
final class SettingsWindowController: NSWindowController {
    static let shared = SettingsWindowController()

    convenience init() {
        let settings = SettingsView()
        let hosting = NSHostingView(rootView: AnyView(settings))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 220),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "PAI Settings"
        window.contentView = hosting
        window.center()
        self.init(window: window)
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

struct SettingsView: View {
    @ObservedObject var endpoints = EndpointManager.shared
    @State private var newHost = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Router endpoints").font(.headline)
            Text("The first one that answers is used, in this order; the app switches when it stops answering.")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(Array(endpoints.candidates.enumerated()), id: \.offset) { _, c in
                HStack(spacing: 6) {
                    Circle().fill(c == endpoints.active ? Color.green : Color.secondary.opacity(0.4)).frame(width: 7, height: 7)
                    Text(c.label).font(.caption.bold()).frame(width: 70, alignment: .leading)
                    Text(c.url.absoluteString).font(.caption.monospaced()).lineLimit(1)
                    Spacer()
                    if let i = endpoints.extras.firstIndex(where: { normalizeHost($0) == c.url }) {
                        Button("Remove") { endpoints.extras.remove(at: i); endpoints.extrasChanged() }.controlSize(.mini)
                    }
                }
            }
            Text(endpoints.active.map { "Using \($0.url.absoluteString)" } ?? "No endpoint answers")
                .font(.caption).foregroundStyle(endpoints.active == nil ? .red : .secondary)
            HStack {
                TextField("Add host (name, name:port or URL)", text: $newHost).textFieldStyle(.roundedBorder)
                Button("Add") {
                    guard normalizeHost(newHost) != nil, !endpoints.extras.contains(newHost) else { return }
                    endpoints.extras.append(newHost); newHost = ""; endpoints.extrasChanged()
                }
            }
        }
        .padding(12)
        .frame(width: 440)
    }
}

/// Drives refresh cadence (2.5 s while the popover is open, 15 s while closed)
/// and the menu bar title.
@MainActor
final class Poller: ObservableObject {
    @Published var title = "PAI"
    @Published var visible = false
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        Task { @MainActor in
            while true {
                await EndpointManager.shared.ensure(failing: Store.shared.error != nil)
                await Store.shared.refresh(baseURL: EndpointManager.shared.baseURL)
                let running = (Store.shared.queue?.jobs() ?? []).filter { $0.state == "running" }.count
                title = Store.shared.error != nil ? "PAI ✕" : menuTitle(running: running, gpu: Store.shared.system?.current?.gpu)
                try? await Task.sleep(nanoseconds: visible ? 2_500_000_000 : 15_000_000_000)
            }
        }
    }
}

@main
struct PAIApp: App {
    @StateObject private var poller = Poller()

    var body: some Scene {
        MenuBarExtra {
            PopoverContent(store: Store.shared, endpoints: EndpointManager.shared, visible: $poller.visible)
        } label: {
            Image(nsImage: makeMenuBarIcon())
            Text(poller.title).task { poller.start() }
        }
        .menuBarExtraStyle(.window)
    }
}
