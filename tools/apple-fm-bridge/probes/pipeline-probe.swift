// Probe run 3: CaseLeaf-style pipeline on FoundationModels @Generable.
// Per page: sections (sub-section headings; whole page if none; token split only if > 1500) -> 3 MCQ cards (one per call,
// text key, options shuffled in code) -> code checks -> blind verify (+ "not answerable") + distractor-truth check
// -> on defect drop + regenerate once (never swap the key) -> PageSummary (3 bullets) + Topics.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe.swift -o $TMPDIR/pipeline-probe
// Run:   $TMPDIR/pipeline-probe <input file or dir of pNN.txt> <out dir> <language, e.g. English|French>
import Foundation
import FoundationModels

@Generable struct Card: Codable {
  @Guide(description: "a multiple-choice question stem that must need the text to answer") var stem: String
  @Guide(description: "the correct answer as plain text, without any letter or number prefix, fully supported by the text") var correctOption: String
  @Guide(description: "three plausible but wrong answers, plain text, never starting with a letter or number prefix such as 'A)', 'a.' or '1.'", .count(3)) var distractors: [String]
  @Guide(description: "why the correct option is right, per the text") var explanation: String
  @Guide(description: "supportingQuote verbatim from the text: one exact contiguous passage copied character for character") var supportingQuote: String
}
@Generable struct Pick: Codable {
  @Guide(description: "index of the correct option, or 4 if the text does not allow answering the question", .range(0...4)) var answerIndex: Int
}
@Generable struct DistractorCheck: Codable {
  @Guide(description: "for each numbered statement in order: true only if the text itself states that statement as true, otherwise false", .count(3)) var statedTrueByText: [Bool]
}
@Generable struct Topics: Codable {
  @Guide(description: "2 to 4 topics the text covers", .count(3)) var topics: [String]
  @Guide(description: "key terms that appear in the text", .count(5)) var keyTerms: [String]
}
@Generable struct PageSummary: Codable {
  @Guide(description: "three short summary bullets of the page; each bullet ends with the page reference in the form (p.NN)", .count(3)) var bullets: [String]
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

func norm(_ s: String) -> String { s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
func words(_ s: String) -> [String] { s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count >= 4 } }
func median(_ a: [Int]) -> Int { a.isEmpty ? 0 : a.sorted()[a.count / 2] }
func tokCount(_ s: String) async -> Int { (try? await model.tokenCount(for: Prompt(s))) ?? s.count / 3 }

func jsonObj<T: Encodable>(_ v: T?) -> Any {
  guard let v, let d = try? enc.encode(v), let o = try? JSONSerialization.jsonObject(with: d) else { return NSNull() }
  return o
}
func line(_ o: [String: Any]) -> String {
  String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
}

struct Span { var text: String; var tokens: Int; var heading: String }

let headingRe = try! NSRegularExpression(pattern: #"^\d+(\.\d+)+\.?\s+\S.*$"#)
func isHeading(_ l: String) -> Bool {
  let t = l.trimmingCharacters(in: .whitespaces)
  return t.count < 120 && headingRe.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
}

/// sections of one page: one per sub-section heading, whole page if none; token split only if a section > 1500 tokens
func sections(_ page: String) async -> [Span] {
  let lines = page.components(separatedBy: "\n")
  var secs: [(String, [String])] = [("", [])]
  for l in lines {
    if isHeading(l) { secs.append((l.trimmingCharacters(in: .whitespaces), [l])) } else { secs[secs.count - 1].1.append(l) }
  }
  if secs.count > 1 && norm(secs[0].1.joined(separator: " ")).count > 0 { // preamble joins the first heading section
    let pre = secs.removeFirst(); secs[0].1 = pre.1 + secs[0].1
  } else if secs.count > 1 { secs.removeFirst() }
  // merge tiny sections into the next (or previous)
  var merged: [(String, [String])] = []
  var carry: [String] = []
  for s in secs {
    let body = carry + s.1
    if norm(body.joined(separator: " ")).count < 250 { carry = body; if merged.isEmpty || true { continue } }
    merged.append((s.0, body)); carry = []
  }
  if !carry.isEmpty { if merged.isEmpty { merged.append((secs.first?.0 ?? "", carry)) } else { merged[merged.count - 1].1 += carry } }
  var out: [Span] = []
  for m in merged {
    let text = m.1.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    let n = await tokCount(text)
    if n <= 1500 { out.append(Span(text: text, tokens: n, heading: m.0)); continue }
    var cur: [String] = []; var curTok = 0
    for p in text.components(separatedBy: "\n\n") where !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let k = await tokCount(p)
      if curTok + k > 1500 && !cur.isEmpty { out.append(Span(text: cur.joined(separator: "\n\n"), tokens: curTok, heading: m.0)); cur = []; curTok = 0 }
      cur.append(p); curTok += k
    }
    if !cur.isEmpty { out.append(Span(text: cur.joined(separator: "\n\n"), tokens: curTok, heading: m.0)) }
  }
  return out
}

let prefixRe = try! NSRegularExpression(pattern: #"^\s*(\(?[A-Za-z]\)|[A-Za-z][\.\):]|\(?\d{1,2}\)|\d{1,2}[\.\):])\s+"#)
func stripPrefix(_ s: String) -> (String, Bool) {
  var r = s.trimmingCharacters(in: .whitespacesAndNewlines); var changed = false
  while let m = prefixRe.firstMatch(in: r, range: NSRange(r.startIndex..., in: r)), let rg = Range(m.range, in: r) {
    r = String(r[rg.upperBound...]); changed = true
  }
  return (r, changed)
}
func hasPrefix(_ s: String) -> Bool { prefixRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

/// prose = lines with at least 4 alphabetic words of length >= 3 (drops table/figure debris)
func proseText(_ page: String) -> String {
  page.components(separatedBy: "\n").filter { l in
    l.components(separatedBy: CharacterSet.whitespaces).filter { w in w.count >= 3 && w.allSatisfy { $0.isLetter || "’'-,;.:".contains($0) } }.count >= 4
  }.map { norm($0) }.joined(separator: " ")
}
let numRe = try! NSRegularExpression(pattern: #"\d+(?:[.,]\d+)?"#)
func numbers(_ s: String) -> [String] {
  numRe.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { Range($0.range, in: s).map { String(s[$0]) } }
}

struct Built {
  var stem: String; var options: [String]; var correctIndex: Int; var explanation: String; var quote: String; var flags: [String]
}

func build(_ c: Card, span: String, page: String) -> Built {
  var flags: [String] = []
  var changed = false
  let (key, k1) = stripPrefix(c.correctOption); changed = changed || k1
  var ds: [String] = []
  for d in c.distractors { let (x, ch) = stripPrefix(d); ds.append(x); changed = changed || ch }
  if changed { flags.append("prefixStripped") }
  let all = [key] + ds
  if all.contains(where: { hasPrefix($0) }) { flags.append("prefixLeft") }
  let n = all.map { norm($0).lowercased() }
  if ds.contains(where: { norm($0).lowercased() == n[0] }) || all.isEmpty { flags.append("distractorEqualsKey") }
  if Set(n.dropFirst()).count != ds.count { flags.append("distractorsDuplicate") }
  if !norm(page).contains(norm(c.supportingQuote)) { flags.append("quoteNotVerbatim") }
  let kw = words(key); let pw = Set(words(page))
  let missing = kw.filter { !pw.contains($0) }
  if !kw.isEmpty && Double(missing.count) / Double(kw.count) > 0.5 { flags.append("keyWordsMissing:" + missing.joined(separator: ",")) }
  let prose = norm(proseText(page))
  let proseNums = Set(numbers(prose))
  let badNums = numbers(c.stem).filter { !proseNums.contains($0) }
  if !badNums.isEmpty { flags.append("stemNumbersNotInProse:" + badNums.joined(separator: ",")) }
  var idx = Array(0..<all.count); idx.shuffle()
  let options = idx.map { all[$0] }
  let ci = idx.firstIndex(of: 0)!
  return Built(stem: c.stem, options: options, correctIndex: ci, explanation: c.explanation, quote: c.supportingQuote, flags: flags)
}

struct CallLog { var name: String; var ms: Int; var tin: Int; var tout: Int }

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
    let base = "You write study material from the given text only, in \(lang). Everything must be supported by the text. If the text contains an obvious typo, a lost symbol or an inconsistent number, do not copy the wrong value and do not build a question on it. Never ask about figures, tables or stray numbers. supportingQuote is always copied verbatim from the text in its original wording. Write ONE multiple-choice question. The correct option and the distractors are plain text with no letter or number prefix."
    let aspects = [
      "a key definition, principle or fact",
      "a cause and effect, a condition, or a rule with its reason",
      "a consequence, a comparison, a quantity, or a common misconception the text corrects",
    ]
    var cardLines: [String] = [], sumLines: [String] = [], topicLines: [String] = []
    var cardMs: [Int] = [], verifyMs: [Int] = [], distMs: [Int] = [], sumMs: [Int] = [], topicMs: [Int] = [], pageMs: [Int] = []
    var tokIn = 0, tokOut = 0, sumTokIn = 0, sumTokOut = 0
    var nCards = 0, errors = 0, regenerated = 0, dropped = 0, stillDisputed = 0, regenFailed = 0, sumRefBad = 0
    var flagCount: [String: Int] = [:], flaggedCards = 0
    let t00 = Date()

    for f in files {
      let pageName = ((f as NSString).lastPathComponent as NSString).deletingPathExtension
      let digits = pageName.filter { $0.isNumber }
      let pageNo = digits.isEmpty ? "00" : digits
      let page = try! String(contentsOfFile: f, encoding: .utf8)
      let spans = await sections(page)
      print("page \(pageNo): \(spans.count) spans \(spans.map { $0.tokens })")
      let tp0 = Date()
      var stems: [String] = []

      func gen(_ sp: Span, aspect: String, hint: String?, logs: inout [CallLog]) async -> Card? {
        var prompt = "Text:\n\n\(sp.text)\n\nWrite one question about \(aspect)."
        if !stems.isEmpty { prompt += "\nQuestions already written for this page (do not repeat their subject):\n" + stems.map { "- \($0)" }.joined(separator: "\n") }
        if let hint { prompt += "\n" + hint }
        for attempt in 0..<2 {
          let r = await call(Card.self, instructions: base, prompt: prompt)
          logs.append(CallLog(name: attempt == 0 ? "card" : "cardRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
          if let v = r.value { return v }
          errors += 1
        }
        return nil
      }
      func check(_ b: Built, sp: Span, logs: inout [CallLog]) async -> (flags: [String], verifyAnswer: Int?) {
        var flags = b.flags
        let opts = b.options.enumerated().map { "\($0.offset). \($0.element)" }.joined(separator: "\n") + "\n4. not answerable from the text"
        let v = await call(Pick.self, instructions: "You are a student answering a multiple-choice question using only the text. Pick the option the text supports; pick 4 only if the text does not allow answering.",
                           prompt: "Text:\n\n\(page)\n\nQuestion: \(b.stem)\nOptions:\n\(opts)\n\nWhich option index is correct?")
        logs.append(CallLog(name: "verify", ms: v.ms, tin: v.tokensIn, tout: v.tokensOut))
        var ans: Int? = nil
        if let p = v.value { ans = p.answerIndex; if p.answerIndex != b.correctIndex { flags.append(p.answerIndex == 4 ? "verifyDisagree:notAnswerable" : "verifyDisagree") } }
        else { flags.append("verifyError"); errors += 1 }
        let wrong = b.options.enumerated().filter { $0.offset != b.correctIndex }.map { $0.element }
        let st = wrong.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        let d = await call(DistractorCheck.self, instructions: "You check statements against a text. A statement counts as true only if the text itself says it (explicitly or by direct consequence).",
                           prompt: "Text:\n\n\(page)\n\nQuestion: \(b.stem)\nCandidate answers, each to be judged as a statement answering the question:\n\(st)\n\nFor each statement in order, does the text state it as true?")
        logs.append(CallLog(name: "distractorCheck", ms: d.ms, tin: d.tokensIn, tout: d.tokensOut))
        if let dv = d.value { if dv.statedTrueByText.contains(true) { flags.append("trueDistractor") } } else { flags.append("distractorCheckError"); errors += 1 }
        return (flags, ans)
      }
      func defect(_ flags: [String]) -> Bool { flags.contains { $0.hasPrefix("verifyDisagree") || $0 == "trueDistractor" } }

      for k in 0..<3 {
        let sp = spans[k % spans.count]
        let aspect = aspects[k]
        var logs: [CallLog] = []
        guard let c1 = await gen(sp, aspect: aspect, hint: nil, logs: &logs) else {
          cardLines.append(line(["page": Int(pageNo) ?? 0, "error": "generation failed", "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] }]))
          continue
        }
        var b = build(c1, span: sp.text, page: page)
        var (flags, ans) = await check(b, sp: sp, logs: &logs)
        var regen = false
        var droppedStem: Any = NSNull()
        if defect(flags) {
          dropped += 1; droppedStem = c1.stem
          let why = flags.contains("trueDistractor") ? "a wrong option could also be true per the text" : "the correct option was not clearly the only answer per the text"
          let hint = "A previous attempt was rejected because \(why) (rejected question: \(c1.stem)). Write a different question whose correct option is unambiguous from the text and whose three distractors are clearly false per the text."
          if let c2 = await gen(sp, aspect: aspect, hint: hint, logs: &logs) {
            regen = true; regenerated += 1
            b = build(c2, span: sp.text, page: page)
            (flags, ans) = await check(b, sp: sp, logs: &logs)
            if defect(flags) { stillDisputed += 1 }
          } else { regenFailed += 1; flags.append("regenFailed") }
        }
        stems.append(b.stem)
        nCards += 1
        if !flags.isEmpty { flaggedCards += 1 }
        for fl in Set(flags.map { $0.split(separator: ":").first.map(String.init) ?? $0 }) { flagCount[fl, default: 0] += 1 }
        for l in logs { tokIn += l.tin; tokOut += l.tout
          switch l.name { case "verify": verifyMs.append(l.ms); case "distractorCheck": distMs.append(l.ms); default: cardMs.append(l.ms) } }
        cardLines.append(line([
          "page": Int(pageNo) ?? 0, "section": sp.heading, "aspect": aspect, "stem": b.stem, "options": b.options, "correctIndex": b.correctIndex,
          "explanation": b.explanation, "supportingQuote": b.quote, "flags": flags, "regenerated": regen, "droppedStem": droppedStem,
          "verifyAnswer": ans.map { $0 as Any } ?? NSNull(),
          "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] },
          "tokens": logs.map { ["call": $0.name, "in": $0.tin, "out": $0.tout] },
          "totalMs": logs.reduce(0) { $0 + $1.ms }
        ]))
        print("page \(pageNo) card \(k + 1) regen=\(regen) flags=\(flags)")
      }

      let s = await call(PageSummary.self, instructions: "You summarise a textbook page in \(lang), from the text only. Exactly three bullets. Each bullet ends with (p.\(pageNo)).",
                         prompt: "Page \(pageNo):\n\n\(page)\n\nSummarise in three bullets, each ending with (p.\(pageNo)).")
      sumMs.append(s.ms); sumTokIn += s.tokensIn; sumTokOut += s.tokensOut
      var refOk = false
      if let sv = s.value { refOk = sv.bullets.allSatisfy { $0.trimmingCharacters(in: .whitespaces).hasSuffix("(p.\(pageNo))") }; if !refOk { sumRefBad += 1 } } else { errors += 1 }
      sumLines.append(line(["page": Int(pageNo) ?? 0, "bullets": s.value.map { jsonObj($0.bullets) } ?? NSNull(), "refOk": refOk, "ms": s.ms,
                            "tokens": ["in": s.tokensIn, "out": s.tokensOut], "error": s.error ?? NSNull()]))
      let t = await call(Topics.self, instructions: "List what the text covers, in \(lang). Key terms must appear in the text.", prompt: "Text:\n\n\(page)")
      topicMs.append(t.ms); tokIn += t.tokensIn; tokOut += t.tokensOut
      if t.value == nil { errors += 1 }
      topicLines.append(line(["page": Int(pageNo) ?? 0, "topics": jsonObj(t.value), "ms": t.ms, "tokens": ["in": t.tokensIn, "out": t.tokensOut]]))
      pageMs.append(Int(Date().timeIntervalSince(tp0) * 1000))
    }
    try? (cardLines.joined(separator: "\n") + "\n").write(toFile: out + "/cards.jsonl", atomically: true, encoding: .utf8)
    try? (sumLines.joined(separator: "\n") + "\n").write(toFile: out + "/summaries.jsonl", atomically: true, encoding: .utf8)
    try? (topicLines.joined(separator: "\n") + "\n").write(toFile: out + "/topics.jsonl", atomically: true, encoding: .utf8)
    func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : "\(n)/\(d) (\(Int(Double(n) * 100 / Double(d)))%)" }
    let rates = flagCount.sorted { $0.key < $1.key }.map { "  - \($0.key): \(pct($0.value, nCards))" }.joined(separator: "\n")
    let sum = """
    # pipeline summary (run 3)

    - input: \(input) (\(files.count) page file(s)), language: \(lang)
    - final cards: \(nCards), call errors: \(errors)
    - cards with any flag: \(pct(flaggedCards, nCards))
    - flag rates (share of final cards):
    \(rates.isEmpty ? "  - none" : rates)
    - dropped on first attempt (verify disagree / not answerable / true distractor): \(dropped)
    - regenerated: \(regenerated), regeneration failed: \(regenFailed), still disputed after regeneration (kept, flagged): \(stillDisputed)
    - median ms per call: card gen \(median(cardMs)), verify \(median(verifyMs)), distractor check \(median(distMs)), summary \(median(sumMs)), topics \(median(topicMs))
    - median ms per page (all calls): \(median(pageMs)); total wall \(Int(Date().timeIntervalSince(t0Wall(t00)) * 1000)) ms
    - total call time ms: cards+checks \(cardMs.reduce(0, +) + verifyMs.reduce(0, +) + distMs.reduce(0, +)), summaries \(sumMs.reduce(0, +)), topics \(topicMs.reduce(0, +))
    - tokens (in/out): cards+checks+topics \(tokIn)/\(tokOut); page summaries \(sumTokIn)/\(sumTokOut) (median summary ms \(median(sumMs)))
    - summaries with a bullet lacking the (p.NN) reference: \(sumRefBad)/\(sumMs.count)
    """
    try? sum.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    print(sum)
  }
}
func t0Wall(_ d: Date) -> Date { d }
