// Probe run 4: CaseLeaf-style pipeline on FoundationModels @Generable.
// Per page: sections -> FactList per span (N=3 facts per page, first sentence of each section prioritised) -> ONE card per fact
// (short text key, options shuffled in code) -> code checks (key length, numbers w/ table exemption, verbatim) ->
// stem check (key answers stem?) + blind verify + per-option verdict WITH stem and verbatim quote (unsupported = downgraded)
// -> on defect regenerate once -> PageSummary (code appends "(p.NN)") + Topics. Progress is flushed per card.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe.swift -o $TMPDIR/pipeline-probe
// Run:   $TMPDIR/pipeline-probe <input file or dir of pNN.txt> <out dir> <language, e.g. English|French>
import Foundation
import FoundationModels

@Generable struct Fact: Codable {
  @Guide(description: "one self-contained fact stated by the text, as one short sentence") var statement: String
  @Guide(description: "quote verbatim from the text: one exact contiguous passage copied character for character that states the fact") var quote: String
}
@Generable struct FactList: Codable {
  @Guide(description: "distinct facts from the text, each about a different thing", .maximumCount(5)) var facts: [Fact]
}
@Generable struct Card: Codable {
  @Guide(description: "a multiple-choice question stem about the given fact that must need the text to answer; the correct option must answer it directly") var stem: String
  @Guide(description: "the correct answer as plain text without letter or number prefix: a short answer, about as long as the distractors, never a copied sentence") var correctOption: String
  @Guide(description: "three plausible but wrong answers, plain text, about as long as the correct answer, never starting with a letter or number prefix such as 'A)', 'a.' or '1.'", .count(3)) var distractors: [String]
  @Guide(description: "why the correct option is right, per the text") var explanation: String
}
@Generable struct Pick: Codable {
  @Guide(description: "index of the correct option, or 4 if the text does not allow answering the question", .range(0...4)) var answerIndex: Int
}
@Generable struct YesNo: Codable {
  @Guide(description: "true if the option is a direct, sensible answer to the question, false otherwise") var answers: Bool
}
@Generable enum Verdict: String, Codable { case yes, no, partly }
@Generable struct OptionVerdict: Codable {
  @Guide(description: "yes if the text shows this option is a correct answer to the question, partly if only partly, otherwise no") var verdict: Verdict
  @Guide(description: "for yes or partly: the exact contiguous passage copied character for character from the text that shows it; empty for no") var quote: String
}
@Generable struct Topics: Codable {
  @Guide(description: "2 to 4 topics the text covers", .count(3)) var topics: [String]
  @Guide(description: "key terms that appear in the text", .count(5)) var keyTerms: [String]
}
@Generable struct PageSummary: Codable {
  @Guide(description: "three short summary bullets of the page", .count(3)) var bullets: [String]
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

func appendLine(_ path: String, _ s: String) {
  guard let d = (s + "\n").data(using: .utf8) else { return }
  if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
  if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(d); try? h.close() }
}
func say(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }

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


/// numbers on table-like lines (>= 2 numbers in a row-like layout) are legitimate in stems
func tableNumbers(_ page: String) -> Set<String> {
  var s = Set<String>()
  for l in page.components(separatedBy: "\n") {
    let n = numbers(l)
    if n.count >= 2 { s.formUnion(n) }
  }
  return s
}

struct Built {
  var stem: String; var options: [String]; var correctIndex: Int; var key: String; var distractors: [String]; var explanation: String; var flags: [String]
}

func build(_ c: Card, page: String) -> Built {
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
  let kw = words(key); let pw = Set(words(page))
  let missing = kw.filter { !pw.contains($0) }
  if !kw.isEmpty && Double(missing.count) / Double(kw.count) > 0.5 { flags.append("keyWordsMissing:" + missing.joined(separator: ",")) }
  let ok = Set(numbers(norm(proseText(page)))).union(tableNumbers(page))
  let badNums = numbers(c.stem).filter { !ok.contains($0) }
  if !badNums.isEmpty { flags.append("stemNumbersNotInProse:" + badNums.joined(separator: ",")) }
  let dl = ds.map { norm($0).count }
  if !dl.isEmpty && Double(norm(key).count) > 1.6 * Double(median(dl)) { flags.append("keyTooLong") }
  var idx = Array(0..<all.count); idx.shuffle()
  let options = idx.map { all[$0] }
  return Built(stem: c.stem, options: options, correctIndex: idx.firstIndex(of: 0)!, key: key, distractors: ds, explanation: c.explanation, flags: flags)
}

struct CallLog { var name: String; var ms: Int; var tin: Int; var tout: Int }

func firstSentence(_ sp: Span) -> String {
  let body = sp.text.components(separatedBy: "\n").filter { !isHeading($0) && !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { norm($0) }.joined(separator: " ")
  var s = body
  if let r = body.range(of: #"[.!?](\s|$)"#, options: .regularExpression) { s = String(body[..<r.upperBound]) }
  return String(s.prefix(300)).trimmingCharacters(in: .whitespaces)
}

@main struct Pipeline {
  static func main() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    let a = CommandLine.arguments
    let input = a[1], out = a[2], lang = a.count > 3 ? a[3] : "English"
    try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    for n in ["cards", "facts", "summaries", "topics"] { try? "".write(toFile: "\(out)/\(n).jsonl", atomically: true, encoding: .utf8) }
    var isDir: ObjCBool = false
    _ = FileManager.default.fileExists(atPath: input, isDirectory: &isDir)
    var files = [input]
    if isDir.boolValue {
      files = ((try? FileManager.default.contentsOfDirectory(atPath: input)) ?? []).filter { $0.hasSuffix(".txt") }.sorted().map { input + "/" + $0 }
    }
    let base = "You write study material from the given text only, in \(lang). Everything must be supported by the text. If the text contains an obvious typo, a lost symbol or an inconsistent number, do not copy the wrong value and do not build a question on it. Never ask about figures, tables or stray numbers. Write ONE multiple-choice question about the given fact. The correct option is a short paraphrase, about as long as each distractor, not a copied sentence. The distractors are plausible but false. All options are plain text with no letter or number prefix."
    var sumMs: [Int] = [], topicMs: [Int] = [], pageMs: [Int] = [], factMs: [Int] = []
    var cardMs: [Int] = [], stemMs: [Int] = [], verifyMs: [Int] = [], verdictMs: [Int] = []
    var tokIn = 0, tokOut = 0, sumTokIn = 0, sumTokOut = 0
    var nCards = 0, nFacts = 0, errors = 0, regenerated = 0, regenFailed = 0, stillDefect = 0, factQuoteBad = 0
    var regenReason: [String: Int] = [:]
    var flagCount: [String: Int] = [:], flaggedCards = 0
    var verdictCount: [String: Int] = [:], downgraded = 0
    let t00 = Date()

    for f in files {
      let pageName = ((f as NSString).lastPathComponent as NSString).deletingPathExtension
      let digits = pageName.filter { $0.isNumber }
      let pageNo = digits.isEmpty ? "00" : digits
      let pageInt = Int(pageNo) ?? 0
      let page = try! String(contentsOfFile: f, encoding: .utf8)
      let spans = await sections(page)
      say("page \(pageNo): \(spans.count) spans \(spans.map { $0.tokens })")
      let tp0 = Date()

      // allocate N = 3 facts per page over the spans (each of the largest spans gets >= 1)
      var alloc = Array(repeating: 0, count: spans.count)
      let order = spans.indices.sorted { spans[$0].tokens > spans[$1].tokens }
      for i in 0..<3 { alloc[order[i % order.count]] += 1 }

      for (si, sp) in spans.enumerated() where alloc[si] > 0 {
        let n = alloc[si]
        let fs = firstSentence(sp)
        var flogs: [CallLog] = []
        let fp = "Text:\n\n\(sp.text)\n\nList \(n) distinct facts (fewer only if the text has fewer) that are worth a study question, each about a different thing. The FIRST fact must be about this first sentence of the section: \"\(fs)\". Prefer definitions, formulas stated in words, rules, conditions, and actions to take. Do not use figures or tables. Each quote is copied verbatim from the text."
        var fl: [Fact] = []
        var fp2 = fp
        for attempt in 0..<2 {
          let r = await call(FactList.self, instructions: "You extract the key facts of a textbook passage in \(lang), from the text only. Always list the requested number of facts when the text has enough content.", prompt: fp2)
          flogs.append(CallLog(name: attempt == 0 ? "facts" : "factsRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
          if let v = r.value { if v.facts.count > fl.count { fl = Array(v.facts.prefix(n)) }; if fl.count >= n || sp.tokens < 120 { break } else { fp2 = fp + "\nYou must list exactly \(n) facts, each from a different sentence of the text." ; continue } }
          errors += 1
        }
        for l in flogs { tokIn += l.tin; tokOut += l.tout; factMs.append(l.ms) }
        for fact in fl {
          nFacts += 1
          let verb = norm(sp.text).contains(norm(fact.quote)) && !norm(fact.quote).isEmpty
          if !verb { factQuoteBad += 1 }
          appendLine("\(out)/facts.jsonl", line(["page": pageInt, "section": sp.heading, "statement": fact.statement, "quote": fact.quote, "quoteVerbatim": verb,
                                                  "firstSentenceTarget": fs, "span": si, "tokens": ["in": flogs.last?.tin ?? 0, "out": flogs.last?.tout ?? 0], "ms": flogs.reduce(0) { $0 + $1.ms }]))
        }
        say("page \(pageNo) span \(si): \(fl.count) facts")

        for fact in fl {
          var logs: [CallLog] = []
          func gen(hint: String?) async -> Card? {
            var prompt = "Text:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\n\nWrite one multiple-choice question that tests exactly this fact."
            if let hint { prompt += "\n" + hint }
            for attempt in 0..<2 {
              let r = await call(Card.self, instructions: base, prompt: prompt)
              logs.append(CallLog(name: attempt == 0 ? "card" : "cardRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              if let v = r.value { return v }
              errors += 1
            }
            return nil
          }
          struct Opt { var text: String; var isKey: Bool; var verdict: String; var quote: String; var supported: Bool }
          func check(_ b: Built) async -> (flags: [String], verifyAnswer: Int?, opts: [Opt]) {
            var flags = b.flags
            // stem check on the key
            let sc = await call(YesNo.self, instructions: "You judge whether an answer fits a question. Be strict about meaning, not about wording.",
                                prompt: "Question: \(b.stem)\nOption: \(b.key)\n\nDoes this option answer this question?")
            logs.append(CallLog(name: "stemCheck", ms: sc.ms, tin: sc.tokensIn, tout: sc.tokensOut))
            if let v = sc.value { if !v.answers { flags.append("brokenStem") } } else { flags.append("stemCheckError"); errors += 1 }
            // blind verify
            let opts = b.options.enumerated().map { "\($0.offset). \($0.element)" }.joined(separator: "\n") + "\n4. not answerable from the text"
            let v = await call(Pick.self, instructions: "You are a student answering a multiple-choice question using only the text. Pick the option the text supports; pick 4 only if the text does not allow answering.",
                               prompt: "Text:\n\n\(page)\n\nQuestion: \(b.stem)\nOptions:\n\(opts)\n\nWhich option index is correct?")
            logs.append(CallLog(name: "verify", ms: v.ms, tin: v.tokensIn, tout: v.tokensOut))
            var ans: Int? = nil
            if let p = v.value { ans = p.answerIndex; if p.answerIndex != b.correctIndex { flags.append(p.answerIndex == 4 ? "verifyDisagree:notAnswerable" : "verifyDisagree") } }
            else { flags.append("verifyError"); errors += 1 }
            // per-option verdict with the stem, quote must be verbatim and contain the claim
            var res: [Opt] = []
            let spanN = norm(sp.text)
            for (i, o) in b.options.enumerated() {
              let isKey = i == b.correctIndex
              if isKey { res.append(Opt(text: o, isKey: true, verdict: "-", quote: "", supported: false)); continue }
              let r = await call(OptionVerdict.self, instructions: "You check one answer option against a text. Answer only from the text. A yes needs a verbatim quote.",
                                 prompt: "Text:\n\n\(sp.text)\n\nQuestion: \(b.stem)\nOption: \(o)\n\nAs an answer to THIS question, is this option correct according to the text? yes / no / partly, plus the verbatim quote that shows it.")
              logs.append(CallLog(name: "optionVerdict", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              guard let ov = r.value else { flags.append("verdictError"); errors += 1; res.append(Opt(text: o, isKey: false, verdict: "error", quote: "", supported: false)); continue }
              var verdict = ov.verdict.rawValue; var supported = false
              if ov.verdict != .no {
                let q = norm(ov.quote)
                let ow = Set(words(o)); let qw = Set(words(q))
                let covers = ow.isEmpty ? false : Double(ow.intersection(qw).count) / Double(ow.count) >= 0.5
                if !q.isEmpty && spanN.contains(q) && covers { supported = true } else { verdict = "unsupported"; downgraded += 1 }
              }
              verdictCount[verdict, default: 0] += 1
              res.append(Opt(text: o, isKey: false, verdict: verdict, quote: ov.quote, supported: supported))
            }
            if res.contains(where: { !$0.isKey && $0.supported }) { flags.append("trueDistractor") }
            return (flags, ans, res)
          }
          func defects(_ flags: [String]) -> [String] {
            flags.compactMap { f in
              let k = f.split(separator: ":").first.map(String.init) ?? f
              return ["verifyDisagree", "trueDistractor", "keyTooLong", "brokenStem"].contains(k) ? k : nil
            }
          }

          guard let c1 = await gen(hint: nil) else {
            appendLine("\(out)/cards.jsonl", line(["page": pageInt, "fact": fact.statement, "error": "generation failed"]))
            continue
          }
          var b = build(c1, page: page)
          var (flags, ans, opts) = await check(b)
          var regen = false
          var droppedStem: Any = NSNull()
          var firstDefects: [String] = []
          let d1 = defects(flags)
          if !d1.isEmpty {
            firstDefects = d1; droppedStem = c1.stem
            for d in Set(d1) { regenReason[d, default: 0] += 1 }
            var whys: [String] = []
            if d1.contains("keyTooLong") { whys.append("the correct option was far longer than the distractors; make it a short paraphrase of at most \(Int(1.4 * Double(median(b.distractors.map { norm($0).count })))) characters") }
            if d1.contains("brokenStem") { whys.append("the correct option did not answer the question; the question must be directly answered by the correct option") }
            if d1.contains("trueDistractor") { whys.append("a wrong option could also be correct per the text; make the distractors clearly false") }
            if d1.contains("verifyDisagree") { whys.append("the correct option was not clearly the only answer per the text") }
            let hint = "A previous attempt (question: \(c1.stem)) was rejected: " + whys.joined(separator: "; ") + "."
            if let c2 = await gen(hint: hint) {
              regen = true; regenerated += 1
              b = build(c2, page: page)
              (flags, ans, opts) = await check(b)
              if !defects(flags).isEmpty { stillDefect += 1 }
            } else { regenFailed += 1; flags.append("regenFailed") }
          }
          nCards += 1
          if !flags.isEmpty { flaggedCards += 1 }
          for fl in Set(flags.map { $0.split(separator: ":").first.map(String.init) ?? $0 }) { flagCount[fl, default: 0] += 1 }
          for l in logs { tokIn += l.tin; tokOut += l.tout
            switch l.name { case "verify": verifyMs.append(l.ms); case "optionVerdict": verdictMs.append(l.ms); case "stemCheck": stemMs.append(l.ms); default: cardMs.append(l.ms) } }
          let optJSON: [[String: Any]] = opts.map { ["text": $0.text, "isKey": $0.isKey, "verdict": $0.verdict, "quote": $0.quote, "supported": $0.supported] }
          appendLine("\(out)/cards.jsonl", line([
            "page": pageInt, "section": sp.heading, "fact": fact.statement, "factQuote": fact.quote, "stem": b.stem, "options": b.options, "correctIndex": b.correctIndex,
            "optionVerdicts": optJSON, "explanation": b.explanation, "flags": flags, "regenerated": regen, "firstDefects": firstDefects, "droppedStem": droppedStem,
            "verifyAnswer": ans.map { $0 as Any } ?? NSNull(),
            "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] },
            "tokens": logs.map { ["call": $0.name, "in": $0.tin, "out": $0.tout] },
            "totalMs": logs.reduce(0) { $0 + $1.ms }
          ]))
          say("page \(pageNo) card \(nCards) regen=\(regen) flags=\(flags)")
        }
      }

      let s = await call(PageSummary.self, instructions: "You summarise a textbook page in \(lang), from the text only. Exactly three short bullets. Do not write page references.",
                         prompt: "Page:\n\n\(page)\n\nSummarise in three bullets.")
      sumMs.append(s.ms); sumTokIn += s.tokensIn; sumTokOut += s.tokensOut
      let bullets = s.value?.bullets.map { norm($0) + " (p.\(pageNo))" }
      if s.value == nil { errors += 1 }
      appendLine("\(out)/summaries.jsonl", line(["page": pageInt, "bullets": bullets.map { $0 as Any } ?? NSNull(), "ms": s.ms,
                                                  "tokens": ["in": s.tokensIn, "out": s.tokensOut], "error": s.error ?? NSNull()]))
      let t = await call(Topics.self, instructions: "List what the text covers, in \(lang). Key terms must appear in the text.", prompt: "Text:\n\n\(page)")
      topicMs.append(t.ms); tokIn += t.tokensIn; tokOut += t.tokensOut
      if t.value == nil { errors += 1 }
      appendLine("\(out)/topics.jsonl", line(["page": pageInt, "topics": jsonObj(t.value), "ms": t.ms, "tokens": ["in": t.tokensIn, "out": t.tokensOut]]))
      pageMs.append(Int(Date().timeIntervalSince(tp0) * 1000))
      say("page \(pageNo) done in \(pageMs.last!) ms")
    }
    func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : "\(n)/\(d) (\(Int(Double(n) * 100 / Double(d)))%)" }
    let rates = flagCount.sorted { $0.key < $1.key }.map { "  - \($0.key): \(pct($0.value, nCards))" }.joined(separator: "\n")
    let verd = verdictCount.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
    let reg = regenReason.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
    let wall = Int(Date().timeIntervalSince(t00) * 1000)
    let sum = """
    # pipeline summary (run 4)

    - input: \(input) (\(files.count) page file(s)), language: \(lang)
    - facts: \(nFacts) (quote not verbatim: \(factQuoteBad)); final cards: \(nCards), call errors: \(errors)
    - cards with any flag: \(pct(flaggedCards, nCards))   [run 3: 23/27 (85%)]
    - flag rates (share of final cards; run 3: quoteNotVerbatim 11%, stemNumbersNotInProse 3%, trueDistractor 85%):
    \(rates.isEmpty ? "  - none" : rates)
    - option verdicts on distractors: \(verd.isEmpty ? "none" : verd); downgraded to unsupported: \(downgraded)
    - regenerated: \(regenerated) [run 3: 26], regeneration failed: \(regenFailed), still defective after regeneration (kept, flagged): \(stillDefect) [run 3: 23]
    - first-attempt defects by reason: \(reg.isEmpty ? "none" : reg)
    - median ms per call: facts \(median(factMs)), card gen \(median(cardMs)), stem check \(median(stemMs)), verify \(median(verifyMs)), option verdict \(median(verdictMs)), summary \(median(sumMs)), topics \(median(topicMs))   [run 3: card 7203, verify 1037, distractor 1260, summary 4182, topics 2664]
    - median ms per page (all calls): \(median(pageMs)) [run 3: 77556]; total wall \(wall) ms [run 3: 595562]
    - total call time ms: facts \(factMs.reduce(0, +)), cards \(cardMs.reduce(0, +)), checks \(stemMs.reduce(0, +) + verifyMs.reduce(0, +) + verdictMs.reduce(0, +)), summaries \(sumMs.reduce(0, +)), topics \(topicMs.reduce(0, +))
    - tokens (in/out): facts+cards+checks+topics \(tokIn)/\(tokOut); page summaries \(sumTokIn)/\(sumTokOut)   [run 3: 91718/10154; 4216/959]
    - summaries: (p.NN) appended in code on all \(sumMs.count)
    """
    try? sum.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    say(sum)
  }
}
