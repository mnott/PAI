// Probe: CaseLeaf-style pipeline on FoundationModels @Generable.
// chunk by tokenCount -> per span: Card, Flashcard, verify (blind), span-support check (code), Topics.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe.swift -o $TMPDIR/pipeline-probe
// Run:   $TMPDIR/pipeline-probe <input file or dir of pNN.txt> <out dir> <language, e.g. English|French>
import Foundation
import FoundationModels

@Generable struct Card: Codable {
  @Guide(description: "a multiple-choice question stem that must need the text to answer") var stem: String
  @Guide(description: "four options; exactly one is correct per the text, the other three plausible but wrong per the text", .count(4)) var options: [String]
  @Guide(description: "index of the correct option", .range(0...3)) var correctIndex: Int
  @Guide(description: "why the correct option is right, per the text") var explanation: String
  @Guide(description: "supportingQuote verbatim from the text: one exact contiguous passage copied character for character") var supportingQuote: String
}
@Generable struct Flashcard: Codable {
  @Guide(description: "front of the card: a question or term that must need the text to answer") var front: String
  @Guide(description: "back of the card: the short answer per the text") var back: String
  @Guide(description: "supportingQuote verbatim from the text: one exact contiguous passage copied character for character") var supportingQuote: String
}
@Generable struct Pick: Codable {
  @Guide(description: "index of the option you believe is correct", .range(0...3)) var answerIndex: Int
}
@Generable struct Topics: Codable {
  @Guide(description: "2 to 4 topics the text covers", .count(3)) var topics: [String]
  @Guide(description: "key terms that appear in the text", .count(5)) var keyTerms: [String]
}

let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
let enc: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; return e }()

struct Timed<T> { var value: T?; var ms: Int; var tokensIn: Int; var tokensOut: Int; var error: String? }

func call<T: Generable & Codable>(_ t: T.Type, instructions: String, prompt: String) async -> Timed<T> {
  let t0 = Date()
  let tin = ((try? await model.tokenCount(for: Instructions(instructions))) ?? 0) + ((try? await model.tokenCount(for: Prompt(prompt))) ?? 0)
  do {
    let s = LanguageModelSession(model: model, instructions: instructions)
    var o = GenerationOptions(); o.maximumResponseTokens = 1500
    let r = try await s.respond(to: prompt, generating: t, options: o)
    let ms = Int(Date().timeIntervalSince(t0) * 1000)
    let j = String(data: try enc.encode(r.content), encoding: .utf8) ?? ""
    return Timed(value: r.content, ms: ms, tokensIn: tin, tokensOut: (try? await model.tokenCount(for: j)) ?? -1, error: nil)
  } catch {
    return Timed(value: nil, ms: Int(Date().timeIntervalSince(t0) * 1000), tokensIn: tin, tokensOut: 0, error: "\(error)")
  }
}

func norm(_ s: String) -> String {
  s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
func words(_ s: String) -> [String] {
  s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count >= 4 }
}
func median(_ a: [Int]) -> Int { a.isEmpty ? 0 : a.sorted()[a.count / 2] }

struct Span { var id: Int; var text: String; var tokens: Int }

func chunk(_ paras: [String], limit: Int) async -> [Span] {
  var spans: [Span] = []; var cur: [String] = []; var curTok = 0
  for p in paras {
    let n = (try? await model.tokenCount(for: Prompt(p))) ?? p.count / 3
    if curTok + n > limit && !cur.isEmpty {
      spans.append(Span(id: spans.count + 1, text: cur.joined(separator: "\n\n"), tokens: curTok)); cur = []; curTok = 0
    }
    cur.append(p); curTok += n
  }
  if !cur.isEmpty { spans.append(Span(id: spans.count + 1, text: cur.joined(separator: "\n\n"), tokens: curTok)) }
  return spans
}

func jsonObj<T: Encodable>(_ v: T?) -> Any {
  guard let v, let d = try? enc.encode(v), let o = try? JSONSerialization.jsonObject(with: d) else { return NSNull() }
  return o
}
func line(_ o: [String: Any]) -> String {
  String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
}

@main struct Pipeline {
  static func main() async {
    let a = CommandLine.arguments
    let input = a[1], out = a[2], lang = a.count > 3 ? a[3] : "English"
    try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    var isDir: ObjCBool = false
    _ = FileManager.default.fileExists(atPath: input, isDirectory: &isDir)
    var files = [input]
    if isDir.boolValue {
      files = ((try? FileManager.default.contentsOfDirectory(atPath: input)) ?? []).filter { $0.hasSuffix(".txt") }.sorted().map { input + "/" + $0 }
    }
    // paragraphs; page files separated, pages kept in order
    var paras: [String] = []
    for f in files {
      let t = try! String(contentsOfFile: f, encoding: .utf8)
      let parts = t.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
      paras += parts
    }
    let spans = await chunk(paras, limit: 1500)
    print("\(spans.count) spans: \(spans.map { $0.tokens })")

    let base = "You write study material from the given text only, in \(lang). Everything must be supported by the text. If the text contains an obvious typo or an inconsistent number, do not copy the wrong value. supportingQuote is always copied verbatim from the text in its original wording."
    var cardLines: [String] = [], topicLines: [String] = []
    var allMs: [Int] = [], flagged = 0, disagree = 0, quoteBad = 0, wordsBad = 0, fcQuoteBad = 0, errors = 0, cards = 0
    var verifyMs: [Int] = [], cardMs: [Int] = [], fcMs: [Int] = [], topicMs: [Int] = []
    for sp in spans {
      let prompt = "Text:\n\n\(sp.text)"
      let c = await call(Card.self, instructions: base + " Write ONE multiple-choice question.", prompt: prompt + "\n\nWrite one card.")
      let f = await call(Flashcard.self, instructions: base + " Write ONE flashcard.", prompt: prompt + "\n\nWrite one flashcard.")
      var v: Timed<Pick>? = nil
      var flags: [String] = []
      if let card = c.value {
        cards += 1
        let opts = card.options.enumerated().map { "\($0.offset). \($0.element)" }.joined(separator: "\n")
        v = await call(Pick.self, instructions: "You are a student answering a multiple-choice question using only the text. Pick the option the text supports.",
                       prompt: "Text:\n\n\(sp.text)\n\nQuestion: \(card.stem)\nOptions:\n\(opts)\n\nWhich option index is correct?")
        if card.options.count != 4 { flags.append("optionCount=\(card.options.count)") }
        if let p = v?.value, p.answerIndex != card.correctIndex { flags.append("verifyDisagree"); disagree += 1 }
        if v?.value == nil { flags.append("verifyError") }
        // span support (code)
        if !norm(sp.text).contains(norm(card.supportingQuote)) { flags.append("quoteNotVerbatim"); quoteBad += 1 }
        if card.options.indices.contains(card.correctIndex) {
          let key = words(card.options[card.correctIndex]); let span = Set(words(sp.text))
          let missing = key.filter { !span.contains($0) }
          if !key.isEmpty && Double(missing.count) / Double(key.count) > 0.5 { flags.append("keyWordsMissing:" + missing.joined(separator: ",")); wordsBad += 1 }
        } else { flags.append("correctIndexOutOfRange") }
        let opt = Set(card.options.map { norm($0).lowercased() }); if opt.count != card.options.count { flags.append("duplicateOptions") }
        if !flags.isEmpty { flagged += 1 }
      } else { errors += 1; flags.append("cardError") }
      var fflags: [String] = []
      if let fc = f.value, !norm(sp.text).contains(norm(fc.supportingQuote)) { fflags.append("quoteNotVerbatim"); fcQuoteBad += 1 }
      if f.value == nil { errors += 1; fflags.append("flashcardError") }
      let t = await call(Topics.self, instructions: "List what the text covers, in \(lang). Key terms must appear in the text.", prompt: prompt)
      if t.value == nil { errors += 1 }

      cardMs.append(c.ms); fcMs.append(f.ms); topicMs.append(t.ms); if let v { verifyMs.append(v.ms) }
      allMs.append(c.ms + f.ms + (v?.ms ?? 0) + t.ms)
      cardLines.append(line([
        "spanId": sp.id, "spanTokens": sp.tokens, "card": jsonObj(c.value), "flashcard": jsonObj(f.value),
        "verifyAnswer": v?.value.map { $0.answerIndex as Any } ?? NSNull(), "flags": flags, "flashcardFlags": fflags,
        "timingsMs": ["card": c.ms, "flashcard": f.ms, "verify": v?.ms ?? 0, "topics": t.ms],
        "tokens": ["card": ["in": c.tokensIn, "out": c.tokensOut], "flashcard": ["in": f.tokensIn, "out": f.tokensOut],
                   "verify": ["in": v?.tokensIn ?? 0, "out": v?.tokensOut ?? 0], "topics": ["in": t.tokensIn, "out": t.tokensOut]],
        "errors": [c.error, f.error, v?.error, t.error].compactMap { $0 }
      ]))
      topicLines.append(line(["spanId": sp.id, "topics": jsonObj(t.value)]))
      print("span \(sp.id) done flags=\(flags) fflags=\(fflags)")
    }
    try? (cardLines.joined(separator: "\n") + "\n").write(toFile: out + "/cards.jsonl", atomically: true, encoding: .utf8)
    try? (topicLines.joined(separator: "\n") + "\n").write(toFile: out + "/topics.jsonl", atomically: true, encoding: .utf8)
    let n = spans.count
    let sum = """
    # pipeline summary

    - input: \(input) (\(files.count) file(s)), language: \(lang)
    - spans: \(n) (tokens: \(spans.map { $0.tokens }))
    - cards generated: \(cards)/\(n), call errors: \(errors)
    - cards flagged (any): \(flagged)/\(cards)
    - verify disagrees with key: \(disagree)/\(cards)
    - card supportingQuote not verbatim: \(quoteBad)/\(cards)
    - key option content words mostly absent from span: \(wordsBad)/\(cards)
    - flashcard supportingQuote not verbatim: \(fcQuoteBad)/\(n)
    - median ms per call: card \(median(cardMs)), flashcard \(median(fcMs)), verify \(median(verifyMs)), topics \(median(topicMs))
    - median ms per span (4 calls): \(median(allMs))
    """
    try? sum.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    print(sum)
  }
}
