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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 560),
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
            DictationSettingsSection()
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
                switch DictationController.shared.status {
                case .recording: title = "● " + title
                case .transcribing: title = "… " + title
                default: break
                }
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
            Text(poller.title).task { poller.start(); DictationController.shared.start() }
        }
        .menuBarExtraStyle(.window)
    }
}

/// Wraps the popover content so the window follows its ideal height.
struct PopoverRoot: View {
    @ObservedObject var store: Store
    @ObservedObject var endpoints: EndpointManager
    @Binding var visible: Bool

    /// The window's preferred size, derived from the measured content height;
    /// nil until the content has been measured (AppKit then sizes to content).
    private var windowSize: CGSize? {
        guard let h = popoverWindowSize(measured: store.contentIdealHeight,
                                        visibleHeight: visibleScreenHeight()) else { return nil }
        return CGSize(width: 420, height: h)
    }

    var body: some View {
        Group {
            if popoverNeedsScroll(ideal: store.contentIdealHeight, visibleHeight: visibleScreenHeight()) {
                ScrollView { PopoverContent(store: store, endpoints: endpoints, visible: $visible) }
            } else {
                PopoverContent(store: store, endpoints: endpoints, visible: $visible)
            }
        }
        .background(WindowConfigurator(windowSize: windowSize))
    }
}

/// Screen height minus the menu bar: the cap for the popover window.
func visibleScreenHeight() -> CGFloat {
    guard let screen = NSScreen.main else { return 1024 }
    return screen.visibleFrame.height
}

/// Keeps the popover window at the content's ideal height, recomputed on every
/// content change. `setFrame` (not just preferredContentSize) is what actually
/// resizes AppKit's MenuBarExtra window; the top edge stays anchored so the
/// panel keeps hanging directly under the menu bar while it grows or shrinks.
struct WindowConfigurator: NSViewRepresentable {
    var windowSize: CGSize?

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { apply(to: v.window, host: v.window?.contentView as? NSHostingView<AnyView>) }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { apply(to: nsView.window, host: nsView.window?.contentView as? NSHostingView<AnyView>) }
    }

    private func apply(to win: NSWindow?, host: NSHostingView<AnyView>?) {
        guard let win, let size = windowSize else { return }
        if let host { host.sizingOptions = [.preferredContentSize] }
        // AppKit grows a window from its origin (bottom), so without this the
        // panel drifts down and leaves a gap under the menu bar; anchoring the
        // top edge keeps it hanging directly below the status item.
        // AppKit already sizes the window to its content once preferredContentSize
        // is set; only force a resize when it did not follow (e.g. after the
        // popover was resized by hand or the host missed an update).
        if frameMatches(win.frame, size: size) { return }
        win.setFrame(resizedFrame(win.frame, height: size.height), display: false)
    }
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
