// Probe run 5 (German): flashcards-first (5a), run-4 MCQ pipeline (5b), map-reduce summaries (5c) over one file per section.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-de.swift -o $TMPDIR/pipeline-probe-de
// Run:   $TMPDIR/pipeline-probe-de <dir of sections> <out dir> German [flash,mcq,sum]
import Foundation
import FoundationModels

@Generable struct Fact: Codable {
  @Guide(description: "quote verbatim from the text, in the original German: one exact contiguous passage (one or two sentences) copied character for character that states the fact; never a heading, a list title or a recap line") var quote: String
  @Guide(description: "the fact as one short German sentence, derived from the quote") var statement: String
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
  @Guide(description: "the exact contiguous passage copied character for character from the text: for yes or partly the passage that shows the option is correct, for no the passage that contradicts the option or shows it is wrong") var quote: String
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
  let (key0, k1) = stripPrefix(c.correctOption); changed = changed || k1
  var ds: [String] = []
  for d in c.distractors { let (x, ch) = stripPrefix(d); ds.append(x); changed = changed || ch }
  if changed { flags.append("prefixStripped") }
  let (key, trimmed) = trimKey(key0, distractors: ds)
  if trimmed { flags.append("keyTrimmed") }
  if mentionsText(c.stem + " " + ([key] + ds).joined(separator: " ")) { flags.append("mentionsText") }
  let sw = Set(words(c.stem)); let kws = words(key)
  if !kws.isEmpty && Double(kws.filter { sw.contains($0) }.count) / Double(kws.count) >= 0.6 { flags.append("keyEchoesStem") }
  if ds.contains(where: { overlapFrac($0, key) >= 0.6 }) { flags.append("equivalentDistractor") }
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


// ---- run 5 additions ----
@Generable struct Flashcard: Codable {
  @Guide(description: "front of the flashcard: a clear question or term that needs the text to answer") var front: String
  @Guide(description: "back of the flashcard: a short, precise answer of one or two sentences, from the text") var back: String
  @Guide(description: "quote verbatim from the text: one exact contiguous passage copied character for character that supports the back") var supportingQuote: String
}
@Generable struct SectionBullets: Codable {
  @Guide(description: "two or three short summary bullets of the section, one sentence each", .minimumCount(2), .maximumCount(3)) var bullets: [String]
}
@Generable struct CombinedItem: Codable {
  @Guide(description: "one summary bullet of the article, one or two sentences, no references") var text: String
  @Guide(description: "numbers of the input bullets this summary bullet is based on", .minimumCount(1), .maximumCount(4)) var sources: [Int]
}
@Generable struct Combined: Codable {
  @Guide(description: "six to eight summary bullets covering the whole article without repeating each other", .minimumCount(6), .maximumCount(8)) var items: [CombinedItem]
}

struct Sec { var article: String; var no: String; var text: String; var tokens: Int; var words: Int; var heading: String; var first: String; var paras: [(Int, String)] }

let tagRe = try! NSRegularExpression(pattern: #"^\[¶(\d+)\]\s*"#)
/// body without heading line and without [¶N] tags (paragraph map kept for code-side references)
func cleanSection(_ raw: String) -> (heading: String, body: String, paras: [(Int, String)]) {
  var ls = raw.components(separatedBy: "\n")
  let heading = ls.isEmpty ? "" : ls.removeFirst().trimmingCharacters(in: .whitespaces)
  var paras: [(Int, String)] = []; var out: [String] = []
  for l in ls {
    let t = l.trimmingCharacters(in: .whitespaces)
    if t.isEmpty { continue }
    if let m = tagRe.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)), let r = Range(m.range, in: t), let nr = Range(m.range(at: 1), in: t) {
      let body = String(t[r.upperBound...]); paras.append((Int(t[nr]) ?? 0, norm(body))); out.append(body)
    } else { out.append(t) }
  }
  return (heading, out.joined(separator: "\n\n"), paras)
}
func paraRef(_ sp: Sec, quote: String) -> String {
  let q = norm(quote)
  if q.isEmpty { return "" }
  return sp.paras.first { $0.1.contains(q) }.map { "¶\($0.0)" } ?? ""
}
let textMentionRe = try! NSRegularExpression(pattern: #"(der|dem|den|im|laut|des) (Text|Textes)\b|die Beschreibung|laut Beschreibung|im Abschnitt|dieser Abschnitt"#, options: .caseInsensitive)
func mentionsText(_ s: String) -> Bool { textMentionRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
func overlapFrac(_ a: String, _ b: String) -> Double {
  let wa = Set(words(a)), wb = Set(words(b)); let m = min(wa.count, wb.count)
  return m == 0 ? 0 : Double(wa.intersection(wb).count) / Double(m)
}
/// shorten an overlong key in code: cut at the first clause boundary if that is still >= 12 characters
func trimKey(_ key: String, distractors: [String]) -> (String, Bool) {
  let dl = median(distractors.map { norm($0).count })
  guard dl > 0, Double(norm(key).count) > 1.6 * Double(dl) else { return (key, false) }
  for sep in [", ", "; ", " – ", " (", " und ", " weil ", " da ", " wobei "] {
    if let r = key.range(of: sep) {
      let cut = String(key[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
      if cut.count >= 12 { return (cut, true) }
    }
  }
  return (key, false)
}

func firstSentence(_ text: String) -> String {
  let ls = text.components(separatedBy: "\n").map { norm($0) }.filter { !$0.isEmpty }
  var body = ls.joined(separator: " ")
  body = body.replacingOccurrences(of: #"\[¶\d+\]\s*"#, with: "", options: .regularExpression)
  var s = body
  if let r = body.range(of: #"[.!?](\s|$)"#, options: .regularExpression) { s = String(body[..<r.upperBound]) }
  return String(s.prefix(300)).trimmingCharacters(in: .whitespaces)
}

func isAccepted(_ flags: [String]) -> Bool { flags.allSatisfy { $0 == "prefixStripped" || $0 == "keyTrimmed" } }
func flagKey(_ f: String) -> String { f.split(separator: ":").first.map(String.init) ?? f }
func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : "\(n)/\(d) (\(Int(Double(n) * 100 / Double(d)))%)" }

struct Stats {
  var facts = 0, factQuoteBad = 0, cards = 0, accepted = 0, regenerated = 0, regenFailed = 0, errors = 0, tokIn = 0, tokOut = 0, wallMs = 0
  var flagCount: [String: Int] = [:]
  var regenReason: [String: Int] = [:]
  var perCall: [String: [Int]] = [:]
  var secMs: [String: Int] = [:]
  var secTok: [String: (Int, Int)] = [:]
  mutating func add(_ l: CallLog, sec: String) {
    tokIn += l.tin; tokOut += l.tout; perCall[l.name, default: []].append(l.ms)
    secMs[sec, default: 0] += l.ms
    let t = secTok[sec] ?? (0, 0); secTok[sec] = (t.0 + l.tin, t.1 + l.tout)
  }
}

func nFacts(_ words: Int) -> Int { words < 100 ? 2 : words < 250 ? 3 : words < 450 ? 4 : 5 }

func extractFacts(_ sp: Sec, lang: String, stats: inout Stats, factsPath: String, mode: String) async {
  let n = nFacts(sp.words)
  let fp = "Section title: \(sp.heading)\n\nText:\n\n\(sp.text)\n\nList \(n) distinct facts (fewer only if the text has fewer) that are worth a study item, each about a different thing. The FIRST fact must be about this first sentence of the section: \"\(sp.first)\". Prefer definitions, rules, conditions and causes. Per fact first copy the verbatim German quote from the text, then write the statement from it. Never use headings, list titles, recap lines (such as Zusammenfassung or Merke), figures or tables as facts; skip garbled formulas. Write the statements in \(lang)."
  var fl: [Fact] = []
  var fp2 = fp
  for attempt in 0..<2 {
    let r = await call(FactList.self, instructions: "You extract the key facts of a textbook passage in \(lang), from the text only. Always list the requested number of facts when the text has enough content.", prompt: fp2)
    stats.add(CallLog(name: attempt == 0 ? "facts" : "factsRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: sp.article + "-" + sp.no)
    if let v = r.value { if v.facts.count > fl.count { fl = Array(v.facts.prefix(n)) }; if fl.count >= n || sp.words < 60 { break } else { fp2 = fp + "\nYou must list exactly \(n) facts, each from a different sentence of the text."; continue } }
    stats.errors += 1
  }
  for fact in fl {
    stats.facts += 1
    let verb = !norm(fact.quote).isEmpty && norm(sp.text).contains(norm(fact.quote))
    if !verb { stats.factQuoteBad += 1 }
    appendLine(factsPath, line(["article": sp.article, "section": sp.no, "heading": sp.heading, "statement": fact.statement, "quote": fact.quote, "quoteVerbatim": verb, "para": paraRef(sp, quote: fact.quote), "target": n]))
  }
  _ = mode
  factsBuf = fl
}
nonisolated(unsafe) var factsBuf: [Fact] = []

@main struct Pipeline {
  static func main() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    let a = CommandLine.arguments
    let input = a[1], out = a[2], lang = a.count > 3 ? a[3] : "German"
    let modes = a.count > 4 ? a[4].components(separatedBy: ",") : ["flash", "mcq", "sum"]
    try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    let names = (try? FileManager.default.contentsOfDirectory(atPath: input)) ?? []
    var secs: [Sec] = []
    for nm in names.filter({ $0.hasSuffix(".txt") }).sorted() {
      let stem = (nm as NSString).deletingPathExtension
      let parts = stem.components(separatedBy: "-")
      let raw = (try! String(contentsOfFile: input + "/" + nm, encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines); let cs = cleanSection(raw); let text = cs.body
      let wc = text.split(whereSeparator: { $0.isWhitespace }).count
      secs.append(Sec(article: parts[0], no: parts.count > 1 ? parts[1] : "00", text: text, tokens: await tokCount(text), words: wc,
                      heading: cs.heading, first: firstSentence(text), paras: cs.paras))
    }
    secs.sort { ($0.article, $0.no) < ($1.article, $1.no) }
    say("sections: \(secs.count) \(secs.map { "\($0.article)-\($0.no):\($0.tokens)" })")
    var report: [String: Stats] = [:]

    // ---------------- 5a flashcards ----------------
    if modes.contains("flash") {
      let path = "\(out)/flashcards.jsonl", fpath = "\(out)/facts-flash.jsonl"
      for p in [path, fpath] { try? "".write(toFile: p, atomically: true, encoding: .utf8) }
      var st = Stats(); let t0 = Date()
      let base = "You write flashcards from the given text only, in \(lang). Everything must be supported by the text. If the text contains a garbled formula, a lost symbol or an inconsistent number, do not build a card on it. Never ask about figures or tables. Write ONE flashcard about the given fact: the front is a clear question or term, the back a short precise answer (one or two sentences) in the wording of the text, supportingQuote copied verbatim from the text."
      for sp in secs {
        let secId = sp.article + "-" + sp.no
        await extractFacts(sp, lang: lang, stats: &st, factsPath: fpath, mode: "flash")
        let fl = factsBuf
        for fact in fl {
          var logs: [CallLog] = []
          func gen(hint: String?) async -> Flashcard? {
            var prompt = "Text:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\n\nWrite one flashcard in \(lang) that tests exactly this fact."
            if let hint { prompt += "\n" + hint }
            for attempt in 0..<2 {
              let r = await call(Flashcard.self, instructions: base, prompt: prompt)
              logs.append(CallLog(name: attempt == 0 ? "card" : "cardRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              if let v = r.value { return v }
              st.errors += 1
            }
            return nil
          }
          func checks(_ c: Flashcard) -> [String] {
            var flags: [String] = []
            if norm(c.supportingQuote).isEmpty || !norm(sp.text).contains(norm(c.supportingQuote)) { flags.append("quoteNotVerbatim") }
            let kw = words(c.back); let pw = Set(words(sp.text))
            let missing = kw.filter { !pw.contains($0) }
            if kw.isEmpty || Double(missing.count) / Double(kw.count) > 0.5 { flags.append("answerWordsMissing:" + missing.joined(separator: ",")) }
            if norm(c.front).isEmpty || norm(c.back).isEmpty { flags.append("emptySide") }
            if norm(c.back).count > 350 { flags.append("backTooLong") }
            if norm(c.front).lowercased().contains(norm(c.back).lowercased()) { flags.append("backInFront") }
            return flags
          }
          guard var c = await gen(hint: nil) else {
            appendLine(path, line(["article": sp.article, "section": sp.no, "fact": fact.statement, "error": "generation failed"])); continue
          }
          var flags = checks(c); var regen = false; var first: [String] = []
          if !flags.isEmpty {
            first = flags; for f in Set(flags.map(flagKey)) { st.regenReason[f, default: 0] += 1 }
            let hint = "A previous attempt (front: \(c.front)) was rejected for: \(flags.map(flagKey).joined(separator: ", ")). The quote must be copied exactly from the text and the back must only use words and facts from the text."
            if let c2 = await gen(hint: hint) { regen = true; st.regenerated += 1; c = c2; flags = checks(c2) } else { st.regenFailed += 1; flags.append("regenFailed") }
          }
          st.cards += 1; if isAccepted(flags) { st.accepted += 1 }
          for f in Set(flags.map(flagKey)) { st.flagCount[f, default: 0] += 1 }
          for l in logs { st.add(l, sec: secId) }
          appendLine(path, line(["article": sp.article, "section": sp.no, "sectionRef": "§\(sp.no)", "para": paraRef(sp, quote: c.supportingQuote), "heading": sp.heading, "fact": fact.statement, "front": c.front, "back": c.back,
                                 "supportingQuote": c.supportingQuote, "flags": flags, "accepted": isAccepted(flags), "regenerated": regen, "firstFlags": first,
                                 "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] }, "tokens": logs.map { ["call": $0.name, "in": $0.tin, "out": $0.tout] },
                                 "totalMs": logs.reduce(0) { $0 + $1.ms }]))
          say("flash \(secId) card \(st.cards) flags=\(flags)")
        }
        say("flash \(secId) done, section ms \(st.secMs[secId] ?? 0)")
      }
      st.wallMs = Int(Date().timeIntervalSince(t0) * 1000); report["flash"] = st
    }

    // ---------------- 5b MCQ (run-4 pipeline) ----------------
    if modes.contains("mcq") {
      let path = "\(out)/cards.jsonl", fpath = "\(out)/facts-mcq.jsonl"
      for p in [path, fpath] { try? "".write(toFile: p, atomically: true, encoding: .utf8) }
      var st = Stats(); let t0 = Date(); var downgraded = 0; var verdictCount: [String: Int] = [:]
      let base = "You write study material from the given text only, in \(lang). Everything must be supported by the text. If the text contains an obvious typo, a lost symbol, a garbled formula or an inconsistent number, do not build a question on it. Never ask about figures, tables or stray numbers. Write ONE multiple-choice question about the given fact. The correct option is a short paraphrase, about as long as each distractor, not a copied sentence. The distractors are plausible but false and clearly different in meaning from the correct option. All options are plain text with no letter or number prefix. Never write 'der Text', 'laut Text' or 'die Beschreibung' in the question or options; ask directly about the subject. The correct option must add new information, not repeat the words of the question."
      for sp in secs {
        let secId = sp.article + "-" + sp.no
        await extractFacts(sp, lang: lang, stats: &st, factsPath: fpath, mode: "mcq")
        let fl = factsBuf
        for fact in fl {
          var logs: [CallLog] = []
          let factVerb = !norm(fact.quote).isEmpty && norm(sp.text).contains(norm(fact.quote))
          func gen(hint: String?) async -> Card? {
            var prompt = "Text:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\n\nWrite one multiple-choice question in \(lang) that tests exactly this fact."
            if let hint { prompt += "\n" + hint }
            for attempt in 0..<2 {
              let r = await call(Card.self, instructions: base, prompt: prompt)
              logs.append(CallLog(name: attempt == 0 ? "card" : "cardRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              if let v = r.value { return v }
              st.errors += 1
            }
            return nil
          }
          struct Opt { var text: String; var isKey: Bool; var verdict: String; var quote: String; var supported: Bool }
          func check(_ b: Built) async -> (flags: [String], verifyAnswer: Int?, opts: [Opt]) {
            var flags = b.flags
            if !factVerb { flags.append("quoteNotVerbatim") }
            let opts = b.options.enumerated().map { "\($0.offset). \($0.element)" }.joined(separator: "\n") + "\n4. not answerable from the text"
            let v = await call(Pick.self, instructions: "You are a student answering a multiple-choice question using only the text. Pick the option the text supports; pick 4 only if the text does not allow answering.",
                               prompt: "Text:\n\n\(sp.text)\n\nQuestion: \(b.stem)\nOptions:\n\(opts)\n\nWhich option index is correct?")
            logs.append(CallLog(name: "verify", ms: v.ms, tin: v.tokensIn, tout: v.tokensOut))
            var ans: Int? = nil
            if let p = v.value { ans = p.answerIndex; if p.answerIndex != b.correctIndex { flags.append(p.answerIndex == 4 ? "verifyDisagree:notAnswerable" : "verifyDisagree") } }
            else { flags.append("verifyError"); st.errors += 1 }
            var res: [Opt] = []
            let spanN = norm(sp.text)
            for (i, o) in b.options.enumerated() {
              if i == b.correctIndex { res.append(Opt(text: o, isKey: true, verdict: "-", quote: "", supported: false)); continue }
              let r = await call(OptionVerdict.self, instructions: "You check one answer option against a text. Answer only from the text. Every verdict (yes, no, partly) needs a verbatim quote from the text: yes/partly the quote that shows the option correct, no the quote that contradicts it.",
                                 prompt: "Text:\n\n\(sp.text)\n\nQuestion: \(b.stem)\nOption: \(o)\n\nAs an answer to THIS question, is this option correct according to the text? yes / no / partly, plus the verbatim quote that shows it.")
              logs.append(CallLog(name: "optionVerdict", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              guard let ov = r.value else { flags.append("verdictError"); st.errors += 1; res.append(Opt(text: o, isKey: false, verdict: "error", quote: "", supported: false)); continue }
              var verdict = ov.verdict.rawValue; var supported = false
              if ov.verdict != .no {
                let q = norm(ov.quote)
                let ow = Set(words(o)); let qw = Set(words(q))
                let covers = ow.isEmpty ? false : Double(ow.intersection(qw).count) / Double(ow.count) >= 0.5
                if !q.isEmpty && spanN.contains(q) && covers { supported = true } else { verdict = "unsupported"; downgraded += 1 }
              } else {
                let q = norm(ov.quote)
                if q.isEmpty || !spanN.contains(q) { verdict = "unsupported"; downgraded += 1 } else { supported = true }
              }
              verdictCount[verdict, default: 0] += 1
              res.append(Opt(text: o, isKey: false, verdict: verdict, quote: ov.quote, supported: supported))
            }
            if res.contains(where: { !$0.isKey && $0.supported && $0.verdict != "no" }) { flags.append("trueDistractor") }
            if res.contains(where: { !$0.isKey && $0.verdict == "unsupported" }) { flags.append("unsupportedVerdict") }
            return (flags, ans, res)
          }
          func defects(_ flags: [String]) -> [String] {
            flags.map(flagKey).filter { ["verifyDisagree", "trueDistractor", "keyTooLong", "equivalentDistractor", "mentionsText", "keyEchoesStem"].contains($0) }
          }
          guard let c1 = await gen(hint: nil) else {
            appendLine(path, line(["article": sp.article, "section": sp.no, "fact": fact.statement, "error": "generation failed"])); continue
          }
          var b = build(c1, page: sp.text)
          var (flags, ans, opts) = await check(b)
          var regen = false; var firstDefects: [String] = []; var droppedStem: Any = NSNull()
          let d1 = defects(flags)
          if !d1.isEmpty {
            firstDefects = d1; droppedStem = c1.stem
            for d in Set(d1) { st.regenReason[d, default: 0] += 1 }
            var whys: [String] = []
            if d1.contains("keyTooLong") { whys.append("the correct option was far longer than the distractors; make it a short paraphrase of at most \(Int(1.4 * Double(median(b.distractors.map { norm($0).count })))) characters") }
            if d1.contains("trueDistractor") { whys.append("a wrong option could also be correct per the text; make the distractors clearly false") }
            if d1.contains("verifyDisagree") { whys.append("the correct option was not clearly the only answer per the text") }
            if d1.contains("equivalentDistractor") { whys.append("a distractor said nearly the same as the correct option; make each distractor clearly different in meaning") }
            if d1.contains("mentionsText") { whys.append("never write 'der Text', 'laut Text' or 'die Beschreibung' in the question or options; ask directly about the subject") }
            if d1.contains("keyEchoesStem") { whys.append("the correct option only repeated words of the question; the answer must add the new information") }
            let hint = "A previous attempt (question: \(c1.stem)) was rejected: " + whys.joined(separator: "; ") + "."
            if let c2 = await gen(hint: hint) {
              regen = true; st.regenerated += 1
              b = build(c2, page: sp.text)
              (flags, ans, opts) = await check(b)
            } else { st.regenFailed += 1; flags.append("regenFailed") }
          }
          st.cards += 1; if isAccepted(flags) { st.accepted += 1 }
          for f in Set(flags.map(flagKey)) { st.flagCount[f, default: 0] += 1 }
          for l in logs { st.add(l, sec: secId) }
          let optJSON: [[String: Any]] = opts.map { ["text": $0.text, "isKey": $0.isKey, "verdict": $0.verdict, "quote": $0.quote, "supported": $0.supported] }
          appendLine(path, line([
            "article": sp.article, "section": sp.no, "sectionRef": "§\(sp.no)", "para": paraRef(sp, quote: fact.quote), "heading": sp.heading, "fact": fact.statement, "factQuote": fact.quote, "stem": b.stem, "options": b.options,
            "correctIndex": b.correctIndex, "optionVerdicts": optJSON, "explanation": b.explanation, "flags": flags, "accepted": isAccepted(flags), "regenerated": regen,
            "firstDefects": firstDefects, "droppedStem": droppedStem, "verifyAnswer": ans.map { $0 as Any } ?? NSNull(),
            "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] }, "tokens": logs.map { ["call": $0.name, "in": $0.tin, "out": $0.tout] },
            "totalMs": logs.reduce(0) { $0 + $1.ms }]))
          say("mcq \(secId) card \(st.cards) regen=\(regen) flags=\(flags)")
        }
        say("mcq \(secId) done, section ms \(st.secMs[secId] ?? 0)")
      }
      st.wallMs = Int(Date().timeIntervalSince(t0) * 1000); report["mcq"] = st
      report["mcq"]!.regenReason["_downgradedVerdicts"] = downgraded
      for (k, v) in verdictCount { report["mcq"]!.regenReason["_verdict_" + k] = v }
    }

    // ---------------- 5c map-reduce summaries ----------------
    var sumSt = Stats(); var sumRefIssues = 0, sumBulletsLow = 0, sumBullets = 0
    if modes.contains("sum") {
      let path = "\(out)/summaries.jsonl"; try? "".write(toFile: path, atomically: true, encoding: .utf8)
      let t0 = Date()
      for article in Array(Set(secs.map { $0.article })).sorted() {
        var flat: [(sec: String, text: String)] = []
        var mapMs = 0
        for sp in secs where sp.article == article {
          let secId = sp.article + "-" + sp.no
          let r = await call(SectionBullets.self, instructions: "You summarise a textbook section in \(lang), from the text only. Two or three short bullets, one sentence each. No references, no section numbers.",
                             prompt: "Section:\n\n\(sp.text)\n\nSummarise in 2 to 3 bullets in \(lang).")
          sumSt.add(CallLog(name: "mapSummary", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId); mapMs += r.ms
          var bl: [String] = []
          if let v = r.value { bl = v.bullets.map { norm($0) } } else { sumSt.errors += 1 }
          let pw = Set(words(sp.text))
          var lows: [Bool] = []
          for b in bl { let kw = words(b); let miss = kw.filter { !pw.contains($0) }; lows.append(!kw.isEmpty && Double(miss.count) / Double(kw.count) > 0.5) }
          sumBullets += bl.count; sumBulletsLow += lows.filter { $0 }.count
          for b in bl { flat.append((sp.no, b)) }
          appendLine(path, line(["stage": "map", "article": article, "section": sp.no, "sectionRef": "§\(sp.no)", "bullets": bl.map { $0 + " (§\(sp.no))" }, "lowOverlapBullets": lows.filter { $0 }.count,
                                 "ms": r.ms, "tokens": ["in": r.tokensIn, "out": r.tokensOut], "error": r.error ?? NSNull()]))
          say("sum map \(secId) \(bl.count) bullets \(r.ms) ms")
        }
        let numbered = flat.enumerated().map { "\($0.offset + 1). \($0.element.text)" }.joined(separator: "\n")
        let r = await call(Combined.self, instructions: "You combine section summaries into one article summary in \(lang), from the given bullets only. Six to eight bullets, no repetition, no references in the text. Give for every bullet the numbers of the input bullets it is based on.",
                           prompt: "Article \(article). Numbered section bullets:\n\n\(numbered)\n\nCombine them into 6 to 8 summary bullets for the whole article, in \(lang). For every bullet give the source bullet numbers.")
        sumSt.add(CallLog(name: "combine", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: article + "-combine")
        var outBullets: [String] = []; var bad = 0
        if let v = r.value {
          for it in v.items {
            let srcs = Array(Set(it.sources.filter { $0 >= 1 && $0 <= flat.count }.map { flat[$0 - 1].sec })).sorted()
            if srcs.isEmpty { bad += 1 }
            outBullets.append(norm(it.text) + (srcs.isEmpty ? "" : " (" + srcs.map { "§\($0)" }.joined(separator: ", ") + ")"))
          }
        } else { sumSt.errors += 1 }
        sumRefIssues += bad
        appendLine(path, line(["stage": "combine", "article": article, "bullets": outBullets, "bulletCount": outBullets.count, "bulletsWithoutValidSource": bad, "inputBullets": flat.count,
                               "ms": r.ms, "mapMs": mapMs, "tokens": ["in": r.tokensIn, "out": r.tokensOut], "error": r.error ?? NSNull()]))
        say("sum combine \(article): \(outBullets.count) bullets \(r.ms) ms")
      }
      sumSt.wallMs = Int(Date().timeIntervalSince(t0) * 1000); report["sum"] = sumSt
    }

    // ---------------- summary ----------------
    func block(_ name: String, _ s: Stats) -> String {
      let rates = s.flagCount.sorted { $0.key < $1.key }.map { "  - \($0.key): \(pct($0.value, s.cards))" }.joined(separator: "\n")
      let reg = s.regenReason.filter { !$0.key.hasPrefix("_") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
      let calls = s.perCall.sorted { $0.key < $1.key }.map { "\($0.key) \(median($0.value.map { $0 })) (n=\($0.value.count))" }.joined(separator: ", ")
      let extra = s.regenReason.filter { $0.key.hasPrefix("_") }.sorted { $0.key < $1.key }.map { "\($0.key.dropFirst())=\($0.value)" }.joined(separator: ", ")
      let secMsAll = s.secMs.filter { !$0.key.hasSuffix("combine") }.values.map { $0 }
      let tpa = s.accepted == 0 ? "n/a" : "\((s.tokIn + s.tokOut) / s.accepted) (in \(s.tokIn / s.accepted), out \(s.tokOut / s.accepted))"
      return """
      ## \(name)

      - facts: \(s.facts) (quote not verbatim: \(s.factQuoteBad)); cards: \(s.cards); accepted (all code checks pass): \(pct(s.accepted, s.cards)); call errors: \(s.errors)
      - flag rates (share of cards; a card can carry several):
      \(rates.isEmpty ? "  - none" : rates)
      - regenerated: \(s.regenerated), regeneration failed: \(s.regenFailed); first-attempt defects by reason: \(reg.isEmpty ? "none" : reg)
      - \(extra.isEmpty ? "" : "option verdicts / downgrades: " + extra)
      - median ms per call: \(calls)
      - ms per section: mean \(secMsAll.isEmpty ? 0 : secMsAll.reduce(0, +) / secMsAll.count), median \(median(secMsAll)), total wall \(s.wallMs) ms (per-section list in timing-sections.json)
      - tokens (in/out): \(s.tokIn)/\(s.tokOut); per accepted card (in+out): \(tpa)
      - ms per accepted card: \(s.accepted == 0 ? "n/a" : "\(s.secMs.values.reduce(0, +) / s.accepted)")
      """
    }
    var md = "# pipeline summary (run 5, \(lang))\n\n- input: \(input) (\(secs.count) sections: \(Set(secs.map { $0.article }).sorted().joined(separator: ", ")))\n\n"
    if let s = report["flash"] { md += block("5a flashcards", s) + "\n\n" }
    if let s = report["mcq"] { md += block("5b mcq", s) + "\n\n" }
    if let f = report["flash"], let m = report["mcq"] {
      let fa = Double(f.accepted) / Double(max(f.cards, 1)), ma = Double(m.accepted) / Double(max(m.cards, 1))
      let fms = f.secMs.values.reduce(0, +) / max(secs.count, 1), mms = m.secMs.values.reduce(0, +) / max(secs.count, 1)
      md += "## 5a vs 5b\n\n| metric | flashcards | mcq |\n|---|---|---|\n| cards | \(f.cards) | \(m.cards) |\n| accepted | \(f.accepted) | \(m.accepted) |\n| acceptance rate | \(Int(fa * 100))% | \(Int(ma * 100))% |\n| mean ms per section | \(fms) | \(mms) |\n| tokens (in+out) per accepted card | \(f.accepted == 0 ? 0 : (f.tokIn + f.tokOut) / f.accepted) | \(m.accepted == 0 ? 0 : (m.tokIn + m.tokOut) / m.accepted) |\n| regenerations | \(f.regenerated) | \(m.regenerated) |\n| total wall ms | \(f.wallMs) | \(m.wallMs) |\n\n"
    }
    if report["sum"] != nil {
      let s = sumSt
      md += "## 5c summaries (map-reduce)\n\n- map calls: \(s.perCall["mapSummary"]?.count ?? 0), median ms \(median(s.perCall["mapSummary"] ?? [])); combine calls: \(s.perCall["combine"]?.count ?? 0), median ms \(median(s.perCall["combine"] ?? []))\n- section bullets: \(sumBullets), with >50% content words missing from the section: \(sumBulletsLow)\n- combined bullets without a valid source (no section ref): \(sumRefIssues)\n- tokens (in/out): \(s.tokIn)/\(s.tokOut); total wall \(s.wallMs) ms; call errors \(s.errors)\n- ms per section (map): " + s.secMs.filter { !$0.key.hasSuffix("combine") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ") + "\n\n"
    }
    // per-section timing json
    var timing: [String: Any] = [:]
    for (k, s) in report { timing[k] = s.secMs.mapValues { $0 }.merging(s.secTok.reduce(into: [String: Int]()) { $0[$1.key + ".tokIn"] = $1.value.0; $0[$1.key + ".tokOut"] = $1.value.1 }) { a, _ in a } }
    if let d = try? JSONSerialization.data(withJSONObject: timing, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/timing-sections.json")) }
    try? md.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    say(md)
  }
}
