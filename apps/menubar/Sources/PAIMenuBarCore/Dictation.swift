import Foundation

/// A whisper.cpp ggml model the dictation can use. Models are never downloaded by the app.
public struct DictationModel: Equatable, Sendable {
    public let id: String
    public let label: String
    public let file: String
    public let sizeMB: Int
    public let note: String
}

public let dictationModels: [DictationModel] = [
    DictationModel(id: "large-v3-turbo-q5_0", label: "Large v3 turbo (q5_0)", file: "ggml-large-v3-turbo-q5_0.bin", sizeMB: 574, note: "best accuracy/speed balance, default"),
    DictationModel(id: "medium", label: "Medium", file: "ggml-medium.bin", sizeMB: 1530, note: "accurate, slower"),
    DictationModel(id: "small", label: "Small", file: "ggml-small.bin", sizeMB: 466, note: "fast, decent accuracy"),
    DictationModel(id: "base", label: "Base", file: "ggml-base.bin", sizeMB: 142, note: "fastest, rough accuracy"),
]
public let defaultDictationModelId = "large-v3-turbo-q5_0"

public func dictationModel(id: String) -> DictationModel? { dictationModels.first { $0.id == id } }

/// Directories searched for ggml files, in order.
public func dictationModelDirs(home: String) -> [String] {
    [home + "/.pai/models/whisper",
     home + "/.cache/aibroker-stt",
     home + "/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels"]
}

/// First existing path of the model's file, nil when not installed.
public func dictationModelPath(_ model: DictationModel, home: String, exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> String? {
    for d in dictationModelDirs(home: home) {
        let p = d + "/" + model.file
        if exists(p) { return p }
    }
    return nil
}

public func availableModels(home: String = NSHomeDirectory(), exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> [DictationModel] {
    dictationModels.filter { dictationModelPath($0, home: home, exists: exists) != nil }
}

public struct DictationHotkey: Codable, Equatable, Sendable {
    public var keyCode: UInt32
    /// Carbon modifier mask (cmdKey 256, shiftKey 512, optionKey 2048, controlKey 4096).
    public var modifiers: UInt32
    public init(keyCode: UInt32, modifiers: UInt32) { self.keyCode = keyCode; self.modifiers = modifiers }
    public static let `default` = DictationHotkey(keyCode: 49, modifiers: 4096 | 2048)

    public var display: String {
        var s = ""
        if modifiers & 4096 != 0 { s += "⌃" }
        if modifiers & 2048 != 0 { s += "⌥" }
        if modifiers & 512 != 0 { s += "⇧" }
        if modifiers & 256 != 0 { s += "⌘" }
        let names: [UInt32: String] = [49: "Space", 36: "Return", 48: "Tab", 96: "F5", 97: "F6", 98: "F7", 100: "F8"]
        return s + (names[keyCode] ?? "key \(keyCode)")
    }
}

public struct DictationSettings: Codable, Equatable, Sendable {
    public var modelId: String = defaultDictationModelId
    /// "auto" or an ISO code.
    public var language: String = "auto"
    public var hotkey: DictationHotkey = .default
    /// true: press starts, release stops; false: press toggles.
    public var pushToTalk: Bool = false
    public var serverURL: String = "http://127.0.0.1:8178"
    /// Placeholder, speaker identification is not implemented (see docs/dictation.md).
    public var speakerLabels: Bool = false

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = DictationSettings()
        modelId = try c.decodeIfPresent(String.self, forKey: .modelId) ?? d.modelId
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? d.language
        hotkey = try c.decodeIfPresent(DictationHotkey.self, forKey: .hotkey) ?? d.hotkey
        pushToTalk = try c.decodeIfPresent(Bool.self, forKey: .pushToTalk) ?? d.pushToTalk
        serverURL = try c.decodeIfPresent(String.self, forKey: .serverURL) ?? d.serverURL
        speakerLabels = try c.decodeIfPresent(Bool.self, forKey: .speakerLabels) ?? d.speakerLabels
    }

    public static func defaultPath(home: String = NSHomeDirectory()) -> String { home + "/.pai/dictation.json" }

    /// Missing or unreadable file yields the defaults.
    public static func load(path: String = defaultPath()) -> DictationSettings {
        guard let data = FileManager.default.contents(atPath: path),
              let s = try? JSONDecoder().decode(DictationSettings.self, from: data) else { return DictationSettings() }
        return s
    }

    public func save(path: String = defaultPath()) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(self).write(to: url, options: .atomic)
    }
}

/// 44-byte RIFF/WAVE header + little-endian PCM16 mono.
public func wavData(pcm16: [Int16], sampleRate: Int) -> Data {
    let dataLen = pcm16.count * 2
    var d = Data()
    func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
    d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataLen)
    d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8)); u32(dataLen)
    for s in pcm16 { u16(Int(UInt16(bitPattern: s))) }
    return d
}

/// POST {url}/inference multipart: file, response_format=json, language.
public func inferenceRequest(url: URL, wav: Data, language: String, boundary: String = "PAI-" + UUID().uuidString) -> URLRequest {
    var req = URLRequest(url: url.appendingPathComponent("inference"))
    req.httpMethod = "POST"
    req.timeoutInterval = 60
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    var body = Data()
    func field(_ name: String, _ value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
    body.append(wav)
    body.append(Data("\r\n".utf8))
    field("response_format", "json")
    field("language", language)
    body.append(Data("--\(boundary)--\r\n".utf8))
    req.httpBody = body
    return req
}

private let hallucinationPatterns = [
    #"^thank(s| you)( so much)?( for (watching|listening))?[.!]*$"#,
    #"^you[.!]*$"#,
    #"^(bye|goodbye)[.!]*$"#,
    #"^vielen dank( fürs? (zuschauen|zuhören))?[.!]*$"#,
    #"^danke( fürs? (zuschauen|zuhören))?[.!]*$"#,
    #"^untertitel.*$"#,
    #"^merci( d'avoir regardé.*)?[.!]*$"#,
    #"^sous-?titr.*$"#,
    #"^dziękuję( za uwagę| za oglądanie)?[.!]*$"#,
    #"^napisy.*$"#,
]

/// Punctuation-only text or a known Whisper filler (mirrors isHallucination in AIBroker stt.ts).
public func isHallucination(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) { return true }
    return hallucinationPatterns.contains { t.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }
}

/// Server JSON {"text": ...} to trimmed text; nil when empty or a hallucination.
public func parseInference(_ data: Data) -> String? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let raw = obj["text"] as? String else { return nil }
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty || isHallucination(t) ? nil : t
}
