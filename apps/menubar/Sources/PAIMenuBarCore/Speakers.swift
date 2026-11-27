import Foundation

/// A diarization turn: who spoke between start and end (seconds).
public struct SpeakerTurn: Equatable {
    public let start: Double
    public let end: Double
    public let speaker: Int
    public init(start: Double, end: Double, speaker: Int) {
        self.start = start; self.end = end; self.speaker = speaker
    }
}

/// A whisper.cpp verbose_json segment.
public struct TextSegment: Equatable {
    public let start: Double
    public let end: Double
    public let text: String
    public init(start: Double, end: Double, text: String) {
        self.start = start; self.end = end; self.text = text
    }
}

/// Parse sherpa-onnx offline speaker diarization lines: "0.318 -- 6.865 speaker_00".
public func parseDiarization(_ output: String) -> [SpeakerTurn] {
    var turns: [SpeakerTurn] = []
    for raw in output.split(whereSeparator: \.isNewline) {
        let parts = raw.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count == 4, parts[1] == "--",
              let s = Double(parts[0]), let e = Double(parts[2]), e >= s,
              parts[3].hasPrefix("speaker_"),
              let id = Int(parts[3].dropFirst("speaker_".count)) else { continue }
        turns.append(SpeakerTurn(start: s, end: e, speaker: id))
    }
    return turns
}

/// Parse segments (start, end, text) from whisper.cpp verbose_json.
public func parseSegments(_ data: Data) -> [TextSegment] {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let segs = obj["segments"] as? [[String: Any]] else { return [] }
    return segs.compactMap { s in
        guard let a = (s["start"] as? NSNumber)?.doubleValue,
              let b = (s["end"] as? NSNumber)?.doubleValue,
              let t = s["text"] as? String else { return nil }
        let text = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : TextSegment(start: a, end: b, text: text)
    }
}

/// Label segments by max-overlap speaker, merge consecutive same-speaker runs,
/// number speakers by first appearance. Without turns: plain joined text.
public func labelSpeakers(segments: [TextSegment], turns: [SpeakerTurn]) -> String {
    let plain = segments.map(\.text).joined(separator: " ")
    guard !turns.isEmpty else { return plain }
    var order: [Int] = []
    var lines: [(Int, String)] = []
    for seg in segments {
        var overlap: [Int: Double] = [:]
        for t in turns {
            let o = min(seg.end, t.end) - max(seg.start, t.start)
            if o > 0 { overlap[t.speaker, default: 0] += o }
        }
        // ties go to the lowest id; no overlap continues the previous speaker
        let best = overlap.max { $0.value != $1.value ? $0.value < $1.value : $0.key > $1.key }?.key
        guard let spk = best ?? lines.last?.0 ?? turns.first?.speaker else { continue }
        if !order.contains(spk) { order.append(spk) }
        if let last = lines.last, last.0 == spk {
            lines[lines.count - 1].1 += " " + seg.text
        } else {
            lines.append((spk, seg.text))
        }
    }
    return lines.map { "Speaker \(order.firstIndex(of: $0.0)! + 1): \($0.1)" }.joined(separator: "\n")
}
