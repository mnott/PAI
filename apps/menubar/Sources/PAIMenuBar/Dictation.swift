import SwiftUI
import AppKit
import AVFoundation
import Carbon.HIToolbox
import ApplicationServices
import PAIMenuBarCore

enum DictationStatus: Equatable {
    case idle, recording, transcribing
    case error(String)
}

private func dictationHotkeyHandler(_ next: EventHandlerCallRef?, _ event: EventRef?, _ ctx: UnsafeMutableRawPointer?) -> OSStatus {
    let kind = GetEventKind(event)
    DispatchQueue.main.async { DictationController.shared.hotkey(pressed: kind == UInt32(kEventHotKeyPressed)) }
    return noErr
}

@MainActor
final class DictationController: ObservableObject {
    static let shared = DictationController()

    @Published private(set) var status: DictationStatus = .idle
    @Published var settings = DictationSettings.load() {
        didSet { try? settings.save(); if settings.hotkey != oldValue.hotkey { registerHotkey() } }
    }

    private var hotKeyRef: EventHotKeyRef?
    private var handlerInstalled = false
    private let engine = AVAudioEngine()
    private var samples: [Int16] = []
    private let lock = NSLock()

    func start() { registerHotkey() }

    private var recorderMonitor: Any?
    @Published private(set) var recordingHotkey = false

    /// Capture the next key combination (Esc cancels, bare non-F keys are ignored).
    func recordHotkey() {
        stopRecordingHotkey()
        recordingHotkey = true
        recorderMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] ev in
            guard let self else { return ev }
            if ev.keyCode == 53 { self.stopRecordingHotkey(); return nil }
            let mods = carbonModifiers(fromEventFlags: ev.modifierFlags.rawValue)
            let code = UInt32(ev.keyCode)
            if isValidDictationHotkey(keyCode: code, modifiers: mods) {
                self.settings.hotkey = DictationHotkey(keyCode: code, modifiers: mods)
                self.stopRecordingHotkey()
            }
            return nil
        }
    }

    func stopRecordingHotkey() {
        if let m = recorderMonitor { NSEvent.removeMonitor(m); recorderMonitor = nil }
        recordingHotkey = false
    }

    // MARK: hotkey

    private func registerHotkey() {
        if let r = hotKeyRef { UnregisterEventHotKey(r); hotKeyRef = nil }
        if !handlerInstalled {
            var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                         EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
            InstallEventHandler(GetApplicationEventTarget(), dictationHotkeyHandler, 2, &types, nil, nil)
            handlerInstalled = true
        }
        let id = EventHotKeyID(signature: OSType(0x50414944), id: 1)
        let rc = RegisterEventHotKey(settings.hotkey.keyCode, settings.hotkey.modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
        if rc != noErr { status = .error("hotkey \(settings.hotkey.display) unavailable") }
    }

    func hotkey(pressed: Bool) {
        if settings.pushToTalk {
            if pressed { beginRecording() } else if status == .recording { finishRecording() }
        } else if pressed {
            status == .recording ? finishRecording() : beginRecording()
        }
    }

    // MARK: recording

    private func beginRecording() {
        guard status == .idle || { if case .error = status { return true }; return false }() else { return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            status = .error("allow the microphone, then retry"); return
        default:
            status = .error("microphone access denied (System Settings > Privacy)"); return
        }
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        let input = engine.inputNode
        let inFmt = input.outputFormat(forBus: 0)
        guard let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let conv = AVAudioConverter(from: inFmt, to: outFmt) else { status = .error("no audio input"); return }
        lock.lock(); samples = []; lock.unlock()
        input.installTap(onBus: 0, bufferSize: 4096, format: inFmt) { [weak self] buf, _ in
            guard let self else { return }
            let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / inFmt.sampleRate) + 16
            guard let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            conv.convert(to: out, error: &err) { _, st in
                if fed { st.pointee = .noDataNow; return nil }
                fed = true; st.pointee = .haveData; return buf
            }
            guard err == nil, let p = out.int16ChannelData?[0] else { return }
            let chunk = Array(UnsafeBufferPointer(start: p, count: Int(out.frameLength)))
            self.lock.lock(); self.samples += chunk; self.lock.unlock()
        }
        do { try engine.start(); status = .recording }
        catch { input.removeTap(onBus: 0); status = .error("audio: \(error.localizedDescription)") }
    }

    private func finishRecording() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock(); let pcm = samples; samples = []; lock.unlock()
        guard pcm.count > 16000 / 4 else { status = .idle; return } // under 0.25 s: ignore
        status = .transcribing
        let wav = wavData(pcm16: pcm, sampleRate: 16000)
        let s = settings
        Task {
            do {
                guard let url = URL(string: s.serverURL) else { throw URLError(.badURL) }
                let (data, resp) = try await URLSession.shared.data(for: inferenceRequest(url: url, wav: wav, language: s.language))
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                if let text = parseInference(data) { insert(text) }
                status = .idle
            } catch {
                status = .error("whisper-server: \(error.localizedDescription)")
            }
        }
    }

    // MARK: insertion

    /// Pasteboard save, set text, Cmd+V, restore. Needs Accessibility permission.
    private func insert(_ text: String) {
        guard AXIsProcessTrusted() else {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
            status = .error("Accessibility needed to paste; text is on the clipboard"); return
        }
        let pb = NSPasteboard.general
        let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
            item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
        }
        pb.clearContents(); pb.setString(text, forType: .string)
        let src = CGEventSource(stateID: .combinedSessionState)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: down)
            e?.flags = .maskCommand
            e?.post(tap: .cghidEventTap)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            pb.clearContents()
            let items = saved.map { entries -> NSPasteboardItem in
                let i = NSPasteboardItem(); for (t, d) in entries { i.setData(d, forType: t) }; return i
            }
            if !items.isEmpty { pb.writeObjects(items) }
        }
    }
}

extension DictationStatus {
    var label: String {
        switch self {
        case .idle: return "Idle"
        case .recording: return "Recording"
        case .transcribing: return "Transcribing"
        case .error(let m): return m
        }
    }
}

struct DictationSettingsSection: View {
    @ObservedObject var dictation = DictationController.shared
    @State private var serverUp: Bool?

    var body: some View {
        let home = NSHomeDirectory()
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Dictation").font(.headline)
            Picker("Model", selection: $dictation.settings.modelId) {
                ForEach(dictationModels, id: \.id) { m in
                    let ok = dictationModelPath(m, home: home) != nil
                    Text("\(m.label) (\(m.sizeMB) MB)\(ok ? " ✓ installed" : " – not installed")").tag(m.id)
                }
            }
            if let m = dictationModel(id: dictation.settings.modelId), dictationModelPath(m, home: home) == nil {
                Text("Not installed. Download \(m.file) into ~/.pai/models/whisper/ (see docs/dictation.md); the server must be started with it.")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Text("Language").frame(width: 70, alignment: .leading)
                TextField("auto or ISO code", text: $dictation.settings.language).textFieldStyle(.roundedBorder).frame(width: 120)
                Toggle("Push to talk", isOn: $dictation.settings.pushToTalk)
            }
            HStack {
                Text("Hotkey").frame(width: 70, alignment: .leading)
                Text(dictation.recordingHotkey ? "press keys… (Esc cancels)" : dictation.settings.hotkey.display).font(.body.monospaced())
                Button(dictation.recordingHotkey ? "Cancel" : "Record") {
                    dictation.recordingHotkey ? dictation.stopRecordingHotkey() : dictation.recordHotkey()
                }.controlSize(.mini)
                Button("Reset to default") { dictation.stopRecordingHotkey(); dictation.settings.hotkey = .default }
                    .controlSize(.mini).disabled(dictation.settings.hotkey == .default)
                Spacer()
                Text(dictation.status.label).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 6) {
                Circle().fill(serverUp == true ? Color.green : serverUp == false ? Color.red : Color.secondary.opacity(0.4)).frame(width: 7, height: 7)
                TextField("whisper-server URL", text: $dictation.settings.serverURL).textFieldStyle(.roundedBorder)
                Button("Check") { Task { await check() } }.controlSize(.mini)
            }
        }
        .task { await check() }
    }

    private func check() async {
        guard let url = URL(string: dictation.settings.serverURL) else { serverUp = false; return }
        var req = URLRequest(url: url); req.timeoutInterval = 2
        serverUp = (try? await URLSession.shared.data(for: req)) != nil
    }
}
