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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 340),
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

/// Drives refresh cadence (1 s while the popover is open, 15 s while closed)
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
                // 1 s while the popover is open, 15 s while closed; sliced so open/close takes effect at once
                let began = Date()
                while Date().timeIntervalSince(began) < (visible ? Store.openInterval : Store.closedInterval) {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
            }
        }
    }
}

@main
struct PAIApp: App {
    @StateObject private var poller = Poller()

    var body: some Scene {
        MenuBarExtra {
            // The window used to keep an old height while the content changed
            // (sections appear/disappear), leaving an empty band. The hosting
            // controller now sizes the window to the content's ideal height,
            // capped at the screen's visible height with scrolling beyond it.
            PopoverRoot(store: Store.shared, endpoints: EndpointManager.shared, visible: $poller.visible)
        } label: {
            Image(nsImage: makeMenuBarIcon())
            Text(poller.title).task { poller.start() }
        }
        .menuBarExtraStyle(.window)
    }
}

/// Wraps the popover content so the window follows its ideal height.
/// `sizingOptions = .preferredContentSize` makes AppKit resize the window on
/// every content change instead of keeping a stale size.
struct PopoverRoot: View {
    @ObservedObject var store: Store
    @ObservedObject var endpoints: EndpointManager
    @Binding var visible: Bool

    var body: some View {
        Group {
            if popoverNeedsScroll(ideal: store.contentIdealHeight, visibleHeight: visibleScreenHeight()) {
                ScrollView { PopoverContent(store: store, endpoints: endpoints, visible: $visible) }
            } else {
                PopoverContent(store: store, endpoints: endpoints, visible: $visible)
            }
        }
        .background(WindowConfigurator())
    }
}

/// Screen height minus the menu bar: the cap for the popover window.
func visibleScreenHeight() -> CGFloat {
    guard let screen = NSScreen.main else { return 1024 }
    return screen.visibleFrame.height
}

/// Applies the sizing options to the window that hosts the popover.
struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            guard let win = v.window else { return }
            if let host = win.contentView as? NSHostingView<AnyView> {
                host.sizingOptions = [.preferredContentSize]
            }
        }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// Admin prompts via AppleScript: no stored password.
enum PowerPrompt {
    static func admin(_ shell: String) -> String? {
        let esc = shell.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        var err: NSDictionary?
        NSAppleScript(source: "do shell script \"\(esc)\" with administrator privileges")?.executeAndReturnError(&err)
        guard let err else { return nil }
        return (err[NSAppleScript.errorMessage] as? String) ?? "declined"
    }

    static func setMode(_ m: PowerMode) -> String? { admin(powerModeAdminShell(m)) }

    /// nil on success, else an error message.
    static func setOptIn(_ on: Bool) -> String? {
        admin(on ? sudoersInstallScript(user: NSUserName()) : sudoersRemoveScript)
    }
}
