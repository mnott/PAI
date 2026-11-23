import SwiftUI
import AppKit
import PAIMenuBarCore

extension Store {
    static let shared = Store()
}

enum SettingsKey {
    static let baseURL = "pai.baseURL"
    static var current: URL {
        let s = UserDefaults.standard.string(forKey: baseURL) ?? "http://127.0.0.1:8790"
        return URL(string: s) ?? URL(string: "http://127.0.0.1:8790")!
    }
}

/// Settings window opened from the popover; brought to front despite LSUIElement.
final class SettingsWindowController: NSWindowController {
    static let shared = SettingsWindowController()

    convenience init() {
        let settings = SettingsView()
        let hosting = NSHostingView(rootView: AnyView(settings))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 140),
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
    @State private var url: String = UserDefaults.standard.string(forKey: SettingsKey.baseURL) ?? "http://127.0.0.1:8790"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Router base URL").font(.caption.bold())
            TextField("http://127.0.0.1:8790", text: $url)
                .textFieldStyle(.roundedBorder)
            Button("Save") {
                UserDefaults.standard.set(url, forKey: SettingsKey.baseURL)
                Task { await Store.shared.refresh(baseURL: SettingsKey.current, forceData: true) }
            }
        }
        .padding(12)
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
                await Store.shared.refresh(baseURL: SettingsKey.current)
                let running = (Store.shared.queue?.jobs() ?? []).filter { $0.slot == "running" }.count
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
            PopoverContent(store: Store.shared, baseURL: SettingsKey.current, visible: $poller.visible)
        } label: {
            Image(nsImage: makeMenuBarIcon())
            Text(poller.title).task { poller.start() }
        }
        .menuBarExtraStyle(.window)
    }
}
