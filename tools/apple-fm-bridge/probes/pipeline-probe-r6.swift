// Probe run 6 (German): the product shape = flashcards by default (6a, coverage-proportional facts), MCQ only from the
// facts of ACCEPTED flashcards (6b, stricter verdicts, no key cutting), map-reduce summaries with dedup + per-section coverage (6c).
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-r6.swift -o $TMPDIR/pipeline-probe-r6
// Run:   $TMPDIR/pipeline-probe-r6 <dir of sections> <out dir> German [flash,mcq,sum]
import Foundation
import FoundationModels

@Generable struct Fact: Codable {
  @Guide(description: "quote verbatim from the text, in the original German: one exact contiguous passage (one or two sentences, never a heading, list title or recap line) copied character for character that states the fact; do not copy the [¶N] tags") var quote: String
  @Guide(description: "the fact as one short, self-contained German sentence that names its subject explicitly, derived from the quote") var statement: String
}
@Generable struct FactList: Codable {
  @Guide(description: "distinct facts from the text, each about a different thing, spread over the whole text", .maximumCount(8)) var facts: [Fact]
}
@Generable struct Card: Codable {
  @Guide(description: "a multiple-choice question stem about the given fact that must need the text to answer; names its subject explicitly; the correct option must answer it directly") var stem: String
  @Guide(description: "the correct answer as plain text without letter or number prefix: a short answer, about as long as the distractors, never a copied sentence") var correctOption: String
  @Guide(description: "three plausible but wrong answers, plain text, about as long as the correct answer, never starting with a letter or number prefix such as 'A)', 'a.' or '1.'", .count(3)) var distractors: [String]
  @Guide(description: "why the correct option is right, per the text") var explanation: String
}
@Generable enum Verdict: String, Codable { case yes, no, partly }
@Generable struct OptionVerdict: Codable {
  @Guide(description: "yes if the text shows this option is a correct answer to the question, partly if only partly, otherwise no") var verdict: Verdict
  @Guide(description: "for yes or partly: the exact contiguous passage copied character for character from the text that shows it; for no: the passage that contradicts the option") var quote: String
}
@Generable struct FalseQuote: Codable {
  @Guide(description: "the exact sentence copied character for character from the text that makes the option false; empty if there is none") var quote: String
}
@Generable struct Flashcard: Codable {
  @Guide(description: "front of the flashcard: a clear question or term that names its subject explicitly (no 'diese', 'solche' or 'dies' without a noun) and needs the text to answer") var front: String
  @Guide(description: "back of the flashcard: a short, precise answer of one or two sentences, from the text, no sentence repeated") var back: String
  @Guide(description: "quote verbatim from the text: one exact contiguous passage copied character for character that supports the back") var supportingQuote: String
}
@Generable struct SectionBullets: Codable {
  @Guide(description: "two or three short summary bullets of the section, one sentence each", .minimumCount(2), .maximumCount(3)) var bullets: [String]
}
@Generable struct CombinedItem: Codable {
  @Guide(description: "one summary bullet of the article, one or two sentences, no references") var text: String
  @Guide(description: "numbers of the input bullets this summary bullet is based on", .minimumCount(1), .maximumCount(5)) var sources: [Int]
}
@Generable struct Combined: Codable {
  @Guide(description: "six to ten summary bullets covering the whole article without repeating each other", .minimumCount(6), .maximumCount(10)) var items: [CombinedItem]
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


// ---- run 6 ----
struct Para { var no: Int; var text: String; var words: Int }
struct Sec { var article: String; var no: String; var text: String; var tagged: String; var tokens: Int; var words: Int; var heading: String; var paras: [Para]; var history: Bool }

let tagRe = try! NSRegularExpression(pattern: #"^\[¶(\d+)\]\s*"#)
/// body without heading line and without [¶N] tags (`text`), the same with tags kept (`tagged`), and the paragraph list
func cleanSection(_ raw: String) -> (heading: String, body: String, tagged: String, paras: [Para]) {
  var ls = raw.components(separatedBy: "\n")
  let heading = ls.isEmpty ? "" : ls.removeFirst().trimmingCharacters(in: .whitespaces)
  var paras: [Para] = []; var out: [String] = []; var tg: [String] = []
  for l in ls {
    let t = l.trimmingCharacters(in: .whitespaces)
    if t.isEmpty { continue }
    tg.append(t)
    if let m = tagRe.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)), let r = Range(m.range, in: t), let nr = Range(m.range(at: 1), in: t) {
      let body = norm(String(t[r.upperBound...]))
      paras.append(Para(no: Int(t[nr]) ?? 0, text: body, words: body.split(separator: " ").count)); out.append(body)
    } else { out.append(t) }
  }
  return (heading, out.joined(separator: "\n\n"), tg.joined(separator: "\n\n"), paras)
}
/// paragraph of a quote: containing paragraph, else the one sharing most content words with the given text
func paraOf(_ sp: Sec, quote: String, fallback: String) -> (Int, Bool) {
  let q = norm(quote)
  if !q.isEmpty, let p = sp.paras.first(where: { $0.text.contains(q) }) { return (p.no, false) }
  var best = (0, 0)
  for p in sp.paras { let k = stems(p.text).intersection(stems(quote + " " + fallback)).count; if k > best.1 { best = (p.no, k) } }
  return (best.0, true)
}
func stems(_ s: String) -> Set<String> { Set(words(s).map { String($0.prefix(5)) }) }
func shared(_ a: String, _ b: String) -> Int { stems(a).intersection(stems(b)).count }
func overlapFrac(_ a: String, _ b: String) -> Double {
  let wa = stems(a), wb = stems(b); let m = min(wa.count, wb.count)
  return m == 0 ? 0 : Double(wa.intersection(wb).count) / Double(m)
}
let textMentionRe = try! NSRegularExpression(pattern: #"(der|dem|den|im|laut|des) (Text|Textes)\b|die Beschreibung|laut Beschreibung|im Abschnitt|dieser Abschnitt"#, options: .caseInsensitive)
func mentionsText(_ s: String) -> Bool { textMentionRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
func rx(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: .caseInsensitive) }
let hedgeRe = rx(#"\b(ebenfalls|auch|andere[nrsm]?|nicht direkt|nur in bestimmten|teilweise)\b"#)
let negRe = rx(#"\b(nicht|kein\w*|nie|niemals|ohne|weder|statt|anstatt|sondern|gegenteil|gegensatz|unabhängig)\b"#)
let demoRe = rx(#"\b(diese[rnms]?|solche[rnms]?|dies|dieses|daher|deshalb|dadurch)\b"#)
func has(_ r: NSRegularExpression, _ s: String) -> Bool { r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
let recapRe = rx(#"^(zusammenfassung|merke|fazit|siehe|abbildung|tabelle)\b"#)
func isHistory(_ h: String) -> Bool { has(rx(#"theorie|geschichte|gap dynamic|hydrologisch"#), h) }

/// duplicate sentences of a back removed in code
func dedupSentences(_ s: String) -> (String, Bool) {
  let parts = norm(s).replacingOccurrences(of: #"(?<=[.!?])\s+"#, with: "\n", options: .regularExpression).components(separatedBy: "\n")
  var seen = Set<String>(); var out: [String] = []
  for p in parts { let k = p.lowercased().trimmingCharacters(in: .punctuationCharacters); if k.isEmpty || seen.contains(k) { continue }; seen.insert(k); out.append(p) }
  return (out.joined(separator: " "), out.count != parts.count)
}

struct CallLog { var name: String; var ms: Int; var tin: Int; var tout: Int }
func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : "\(n)/\(d) (\(Int(Double(n) * 100 / Double(d)))%)" }
func flagKey(_ f: String) -> String { f.split(separator: ":").first.map(String.init) ?? f }

struct Stats {
  var facts = 0, factQuoteBad = 0, factsRejected = 0, cards = 0, accepted = 0, review = 0, regenerated = 0, regenFailed = 0, errors = 0, tokIn = 0, tokOut = 0, wallMs = 0
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

// ---- 6a facts: proportional to length, spread over paragraphs ----
struct FactRec { var statement: String; var quote: String; var para: Int; var verbatim: Bool; var guessed: Bool }

func extractFacts(_ sp: Sec, lang: String, stats: inout Stats, factsPath: String, mode: String) async -> [FactRec] {
  let secId = sp.article + "-" + sp.no
  let big = sp.paras.filter { $0.words > 60 }
  let n = min(8, max(1, Int((Double(sp.words) / 80).rounded()), big.count))
  let spN = norm(sp.text)
  var recs: [FactRec] = []
  var rejected: [[String: Any]] = []
  func consider(_ f: Fact, scope: Sec) {
    let q = norm(f.quote), st = norm(f.statement)
    let verb = !q.isEmpty && spN.contains(q)
    var why = ""
    if q.isEmpty || st.isEmpty { why = "empty" }
    else if q.split(separator: " ").count < 6 { why = "quoteTooShort" }
    else if q.hasSuffix(":") { why = "listStub" }
    else if has(recapRe, q) { why = "recap" }
    else if overlapFrac(q, sp.heading) >= 0.99 && q.split(separator: " ").count < 10 { why = "heading" }
    if why.isEmpty {
      let (p, g) = paraOf(sp, quote: f.quote, fallback: f.statement)
      if recs.filter({ $0.para == p }).count >= 2 { why = "paraCap" }
      else if recs.contains(where: { $0.para == p && overlapFrac($0.statement, st) >= 0.7 }) { why = "duplicate" }
      else { recs.append(FactRec(statement: st, quote: q, para: p, verbatim: verb, guessed: g)) }
    }
    if !why.isEmpty { rejected.append(["quote": q, "statement": st, "why": why]); stats.factsRejected += 1 }
  }
  let ins = "You extract the key facts of a textbook passage in \(lang), from the text only. Every fact must stand on its own: name the subject explicitly, never write 'diese', 'solche' or 'dies' without saying what is meant."
  let fp = "Section title: \(sp.heading)\n\nText (the [¶N] tags number the paragraphs; never copy them):\n\n\(sp.tagged)\n\nList \(n) distinct facts, spread over the whole text: every paragraph of more than 60 words must be used for at least one fact, no paragraph for more than two. Per fact first copy the verbatim German quote (one or two sentences) from the text, then write the statement in \(lang) from it. Prefer definitions, causes, conditions and numeric rules over history and attribution. Never use headings, list titles, recap lines (Zusammenfassung, Merke), figures, tables or sentences that end in a colon as facts; skip garbled formulas."
  for attempt in 0..<2 {
    let r = await call(FactList.self, instructions: ins, prompt: attempt == 0 ? fp : fp + "\nYou must list \(n) facts, each from a different sentence of the text.")
    stats.add(CallLog(name: attempt == 0 ? "facts" : "factsRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId)
    guard let v = r.value else { stats.errors += 1; continue }
    for f in v.facts { consider(f, scope: sp) }
    if recs.count * 2 >= n || sp.words < 60 { break }
  }
  // paragraphs over 60 words still without a fact: one targeted call each
  for p in big where !recs.contains(where: { $0.para == p.no }) {
    let k = min(2, max(1, p.words / 80))
    let r = await call(FactList.self, instructions: ins, prompt: "Section title: \(sp.heading)\n\nParagraph:\n\n\(p.text)\n\nList \(k) fact(s) from this paragraph. Per fact first copy the verbatim German quote (one or two sentences), then write the statement in \(lang). Never use sentences that end in a colon, headings or recap lines.")
    stats.add(CallLog(name: "factsPara", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId)
    guard let v = r.value else { stats.errors += 1; continue }
    for f in v.facts.prefix(k) { consider(f, scope: sp) }
  }
  for f in recs {
    stats.facts += 1; if !f.verbatim { stats.factQuoteBad += 1 }
    appendLine(factsPath, line(["article": sp.article, "section": sp.no, "heading": sp.heading, "statement": f.statement, "quote": f.quote, "quoteVerbatim": f.verbatim, "para": "¶\(f.para)", "paraGuessed": f.guessed, "target": n]))
  }
  for r in rejected { appendLine(factsPath, line(["article": sp.article, "section": sp.no, "rejectedFact": r])) }
  _ = mode
  return recs
}

// ---- 6b MCQ build (no key cutting) ----
struct Built {
  var stem: String; var options: [String]; var correctIndex: Int; var key: String; var distractors: [String]; var explanation: String; var flags: [String]
}
func build(_ c: Card, page: String, factQuote: String) -> Built {
  var flags: [String] = []
  var changed = false
  let (key, k1) = stripPrefix(c.correctOption); changed = changed || k1
  var ds: [String] = []
  for d in c.distractors { let (x, ch) = stripPrefix(d); ds.append(x); changed = changed || ch }
  if changed { flags.append("prefixStripped") }
  if mentionsText(c.stem + " " + ([key] + ds).joined(separator: " ")) { flags.append("mentionsText") }
  let sw = Set(words(c.stem)); let kws = words(key)
  if !kws.isEmpty && Double(kws.filter { sw.contains($0) }.count) / Double(kws.count) >= 0.6 { flags.append("keyEchoesStem") }
  if norm(c.stem).lowercased().contains(norm(key).lowercased()) { flags.append("keyInStem") }
  if ds.contains(where: { overlapFrac($0, key) >= 0.6 }) { flags.append("equivalentDistractor") }
  if ds.contains(where: { has(hedgeRe, $0) }) { flags.append("hedgeDistractor") }
  if has(demoRe, c.stem) { flags.append("stemDemonstrative") }
  // key must be entailed by the fact quote: its content words are in the quote
  let ks = stems(key)
  if ks.isEmpty || Double(ks.intersection(stems(factQuote)).count) / Double(ks.count) < 0.6 { flags.append("keyNotEntailed") }
  let all = [key] + ds
  if all.contains(where: { hasPrefix($0) }) { flags.append("prefixLeft") }
  let n = all.map { norm($0).lowercased() }
  if ds.contains(where: { norm($0).lowercased() == n[0] }) || all.isEmpty { flags.append("distractorEqualsKey") }
  if Set(n.dropFirst()).count != ds.count { flags.append("distractorsDuplicate") }
  let ok = Set(numbers(norm(proseText(page)))).union(tableNumbers(page))
  let badNums = numbers(c.stem).filter { !ok.contains($0) }
  if !badNums.isEmpty { flags.append("stemNumbersNotInProse:" + badNums.joined(separator: ",")) }
  let dl = ds.map { norm($0).count }
  if !dl.isEmpty && Double(norm(key).count) > 1.5 * Double(median(dl)) { flags.append("keyTooLong") }
  var idx = Array(0..<all.count); idx.shuffle()
  return Built(stem: c.stem, options: idx.map { all[$0] }, correctIndex: idx.firstIndex(of: 0)!, key: key, distractors: ds, explanation: c.explanation, flags: flags)
}
let softFlags: Set<String> = ["prefixStripped", "unsupportedVerdict", "quoteNotVerbatim", "stemDemonstrative", "verdictError", "backDeduped", "frontDemonstrative", "paraGuessed"]
func isAccepted(_ flags: [String]) -> Bool { flags.allSatisfy { softFlags.contains(flagKey($0)) } }
func isClean(_ flags: [String]) -> Bool { flags.allSatisfy { $0 == "prefixStripped" || $0 == "backDeduped" } }

struct FC { var sec: Sec; var fact: FactRec; var front: String; var back: String; var quote: String; var flags: [String]; var accepted: Bool }
struct McqRec { var sec: Sec; var para: Int; var accepted: Bool; var clean: Bool }

@main struct Pipeline {
  static func main() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    let a = CommandLine.arguments
    let input = a[1], out = a[2], lang = a.count > 3 ? a[3] : "German"
    let modes = a.count > 4 ? a[4].components(separatedBy: ",") : ["flash", "mcq", "sum"]
    let run5 = a.count > 5 ? a[5] : ""
    try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    let names = (try? FileManager.default.contentsOfDirectory(atPath: input)) ?? []
    var secs: [Sec] = []
    for nm in names.filter({ $0.hasSuffix(".txt") }).sorted() {
      let stem = (nm as NSString).deletingPathExtension
      let parts = stem.components(separatedBy: "-")
      let raw = (try! String(contentsOfFile: input + "/" + nm, encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines); let cs = cleanSection(raw)
      secs.append(Sec(article: parts[0], no: parts.count > 1 ? parts[1] : "00", text: cs.body, tagged: cs.tagged, tokens: await tokCount(cs.body),
                      words: cs.body.split(whereSeparator: { $0.isWhitespace }).count, heading: cs.heading, paras: cs.paras, history: isHistory(cs.heading)))
    }
    secs.sort { ($0.article, $0.no) < ($1.article, $1.no) }
    say("sections: \(secs.count) \(secs.map { "\($0.article)-\($0.no):\($0.words)w" })")
    var report: [String: Stats] = [:]
    var fcs: [FC] = []
    var mcqs: [McqRec] = []

    // ---------------- 6a flashcards ----------------
    if modes.contains("flash") {
      let path = "\(out)/flashcards.jsonl", fpath = "\(out)/facts-flash.jsonl"
      for p in [path, fpath] { try? "".write(toFile: p, atomically: true, encoding: .utf8) }
      var st = Stats(); let t0 = Date()
      let base = "You write flashcards from the given text only, in \(lang). Everything must be supported by the text. If the text contains a garbled formula, a lost symbol or an inconsistent number, do not build a card on it. Never ask about figures or tables. Write ONE flashcard about the given fact: the front is a clear question or term that names its subject explicitly (it must be understandable without the text; never 'diese Effekte', 'solche', 'dies' without saying what is meant), the back a short precise answer (one or two sentences, no sentence twice) in the wording of the text, supportingQuote copied verbatim from the text."
      for sp in secs {
        let secId = sp.article + "-" + sp.no
        let fl = await extractFacts(sp, lang: lang, stats: &st, factsPath: fpath, mode: "flash")
        for fact in fl {
          var logs: [CallLog] = []
          func gen(hint: String?) async -> Flashcard? {
            var prompt = "Section title: \(sp.heading)\n\nText:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\n\nWrite one flashcard in \(lang) that tests exactly this fact. The front must name the subject of the section/fact explicitly."
            if let hint { prompt += "\n" + hint }
            for attempt in 0..<2 {
              let r = await call(Flashcard.self, instructions: base, prompt: prompt)
              logs.append(CallLog(name: attempt == 0 ? "card" : "cardRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              if let v = r.value { return v }
              st.errors += 1
            }
            return nil
          }
          func checks(_ c0: Flashcard) -> (Flashcard, [String]) {
            var c = c0; var flags: [String] = []
            let (b, dd) = dedupSentences(c.back); c.back = b; if dd { flags.append("backDeduped") }
            if norm(c.supportingQuote).isEmpty || !norm(sp.text).contains(norm(c.supportingQuote)) { flags.append("quoteNotVerbatim") }
            let kw = words(c.back); let pw = Set(words(sp.text))
            let missing = kw.filter { !pw.contains($0) }
            if kw.isEmpty || Double(missing.count) / Double(kw.count) > 0.5 { flags.append("answerWordsMissing:" + missing.joined(separator: ",")) }
            if norm(c.front).isEmpty || norm(c.back).isEmpty { flags.append("emptySide") }
            else if norm(c.back).hasSuffix(":") || c.back.split(separator: " ").count < 2 { flags.append("backStub") }
            if norm(c.back).count > 350 { flags.append("backTooLong") }
            if !norm(c.back).isEmpty && norm(c.front).lowercased().contains(norm(c.back).lowercased()) { flags.append("backInFront") }
            if has(demoRe, c.front) { flags.append("frontDemonstrative") }
            return (c, flags)
          }
          let hardRegen: Set<String> = ["quoteNotVerbatim", "frontDemonstrative", "answerWordsMissing", "emptySide", "backStub", "backTooLong", "backInFront"]
          guard let c0 = await gen(hint: nil) else {
            appendLine(path, line(["article": sp.article, "section": sp.no, "fact": fact.statement, "error": "generation failed"])); continue
          }
          var (c, flags) = checks(c0); var regen = false; var first: [String] = []
          let need = flags.map(flagKey).filter { hardRegen.contains($0) }
          if !need.isEmpty {
            first = flags; for f in Set(need) { st.regenReason[f, default: 0] += 1 }
            let hint = "A previous attempt (front: \(c.front)) was rejected for: \(need.joined(separator: ", ")). The quote must be copied exactly from the text, the front must name its subject (no 'diese'/'solche'/'dies'), and the back must only use words and facts from the text and not be empty."
            if let c2 = await gen(hint: hint) { regen = true; st.regenerated += 1; (c, flags) = checks(c2) } else { st.regenFailed += 1; flags.append("regenFailed") }
          }
          let acc = isAccepted(flags)
          st.cards += 1; if acc { st.accepted += 1; if isClean(flags) { st.review += 0 } else { st.review += 1 } }
          for f in Set(flags.map(flagKey)) { st.flagCount[f, default: 0] += 1 }
          for l in logs { st.add(l, sec: secId) }
          fcs.append(FC(sec: sp, fact: fact, front: c.front, back: c.back, quote: c.supportingQuote, flags: flags, accepted: acc))
          appendLine(path, line(["article": sp.article, "section": sp.no, "sectionRef": "§\(sp.no)", "para": "¶\(fact.para)", "heading": sp.heading, "fact": fact.statement, "factQuote": fact.quote, "front": c.front, "back": c.back,
                                 "supportingQuote": c.supportingQuote, "flags": flags, "accepted": acc, "review": acc && !isClean(flags), "regenerated": regen, "firstFlags": first,
                                 "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] }, "tokens": logs.map { ["call": $0.name, "in": $0.tin, "out": $0.tout] },
                                 "totalMs": logs.reduce(0) { $0 + $1.ms }]))
          say("flash \(secId) card \(st.cards) flags=\(flags)")
        }
        say("flash \(secId) done, section ms \(st.secMs[secId] ?? 0)")
      }
      st.wallMs = Int(Date().timeIntervalSince(t0) * 1000); report["flash"] = st
    }

    // ---------------- 6b MCQ from ACCEPTED flashcards ----------------
    if modes.contains("mcq") && !modes.contains("flash"), let txt = try? String(contentsOfFile: "\(out)/flashcards.jsonl", encoding: .utf8) {
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {   // resume: accepted flashcards of an earlier 6a run in the same out dir
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any], let ar = o["article"] as? String, let se = o["section"] as? String,
              let sp = secs.first(where: { $0.article == ar && $0.no == se }), let fact = o["fact"] as? String, let fq = o["factQuote"] as? String,
              let front = o["front"] as? String, let back = o["back"] as? String, let flags = o["flags"] as? [String], let acc = o["accepted"] as? Bool else { continue }
        let para = Int(((o["para"] as? String) ?? "").replacingOccurrences(of: "¶", with: "")) ?? 0
        fcs.append(FC(sec: sp, fact: FactRec(statement: fact, quote: fq, para: para, verbatim: norm(sp.text).contains(norm(fq)), guessed: false), front: front, back: back, quote: (o["supportingQuote"] as? String) ?? "", flags: flags, accepted: acc))
      }
    }
    let onlyArticles = (ProcessInfo.processInfo.environment["MCQ_ARTICLES"] ?? "").components(separatedBy: ",").filter { !$0.isEmpty }
    if modes.contains("mcq") {
      let path = "\(out)/cards.jsonl"
      try? "".write(toFile: path, atomically: true, encoding: .utf8)
      var st = Stats(); let t0 = Date(); var downgraded = 0, secondRescued = 0, secondFailed = 0; var verdictCount: [String: Int] = [:]
      st.facts = fcs.filter { $0.accepted }.count
      let base = "You write study material from the given text only, in \(lang). Everything must be supported by the text. Write ONE multiple-choice question about the given fact. The question names its subject explicitly (never 'diese', 'solche', 'dies' without a noun) and does not contain the answer. The correct option is a short paraphrase of the given answer of 20 to 70 characters, not a copied sentence. The three distractors are plausible but clearly false per the text, clearly different in meaning from the correct option, and about as long as it. Never use hedge words in options: ebenfalls, auch, andere, teilweise, nur in bestimmten. All options are plain text with no letter or number prefix. Never write 'der Text', 'laut Text' or 'die Beschreibung'."
      for sp in secs where onlyArticles.isEmpty || onlyArticles.contains(sp.article) {
        let secId = sp.article + "-" + sp.no
        for fc in fcs where fc.accepted && fc.sec.article == sp.article && fc.sec.no == sp.no {
          let fact = fc.fact
          var logs: [CallLog] = []
          func gen(hint: String?) async -> Card? {
            var prompt = "Section title: \(sp.heading)\n\nText:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\nAccepted answer (basis for the correct option): \(fc.back)\n\nWrite one multiple-choice question in \(lang) that tests exactly this fact."
            if let hint { prompt += "\n" + hint }
            for attempt in 0..<2 {
              let r = await call(Card.self, instructions: base, prompt: prompt)
              logs.append(CallLog(name: attempt == 0 ? "card" : "cardRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              if let v = r.value { return v }
              st.errors += 1
            }
            return nil
          }
          struct Opt { var text: String; var isKey: Bool; var verdict: String; var quote: String; var supported: Bool; var second: Bool }
          func check(_ b: Built) async -> (flags: [String], opts: [Opt]) {
            var flags = b.flags
            if !fact.verbatim { flags.append("quoteNotVerbatim") }
            var res: [Opt] = []
            let spanN = norm(sp.text)
            for (i, o) in b.options.enumerated() {
              if i == b.correctIndex { res.append(Opt(text: o, isKey: true, verdict: "-", quote: "", supported: false, second: false)); continue }
              let r = await call(OptionVerdict.self, instructions: "You check one answer option against a text. Answer only from the text. Every verdict (yes, no, partly) needs a verbatim quote from the text: yes/partly the quote that shows the option correct, no the quote that contradicts it.",
                                 prompt: "Text:\n\n\(sp.text)\n\nQuestion: \(b.stem)\nOption: \(o)\n\nAs an answer to THIS question, is this option correct according to the text? yes / no / partly, plus the verbatim quote.")
              logs.append(CallLog(name: "optionVerdict", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut))
              guard let ov = r.value else { flags.append("verdictError"); st.errors += 1; res.append(Opt(text: o, isKey: false, verdict: "error", quote: "", supported: false, second: false)); continue }
              var verdict = ov.verdict.rawValue; var supported = false; var second = false; var quote = norm(ov.quote)
              let q = quote; let inText = !q.isEmpty && spanN.contains(q)
              if ov.verdict != .no {
                let ow = Set(words(o)); let qw = Set(words(q))
                let covers = ow.isEmpty ? false : Double(ow.intersection(qw).count) / Double(ow.count) >= 0.5
                if inText && covers { supported = true } else { verdict = "unsupported" }
              } else if !(inText && (shared(o, q) >= 2 || has(negRe, q))) { verdict = "unsupported" } else { supported = true }
              if verdict == "unsupported" {
                downgraded += 1
                let r2 = await call(FalseQuote.self, instructions: "You find the sentence of a text that makes an answer option false. Copy it exactly.",
                                    prompt: "Text:\n\n\(sp.text)\n\nQuestion: \(b.stem)\nOption: \(o)\n\nQuote the sentence from the text that makes this option false (verbatim), or leave it empty if the text does not contradict it.")
                logs.append(CallLog(name: "falseQuote", ms: r2.ms, tin: r2.tokensIn, tout: r2.tokensOut))
                let q2 = norm(r2.value?.quote ?? "")
                if !q2.isEmpty && spanN.contains(q2) && shared(o, q2) >= 1 { verdict = "no"; supported = true; second = true; quote = q2; secondRescued += 1 } else { secondFailed += 1 }
              }
              verdictCount[verdict, default: 0] += 1
              res.append(Opt(text: o, isKey: false, verdict: verdict, quote: quote, supported: supported, second: second))
            }
            if res.contains(where: { !$0.isKey && $0.supported && $0.verdict != "no" }) { flags.append("trueDistractor") }
            if res.contains(where: { !$0.isKey && $0.verdict == "unsupported" }) { flags.append("unsupportedVerdict") }
            return (flags, res)
          }
          let defectSet: Set<String> = ["trueDistractor", "keyTooLong", "equivalentDistractor", "mentionsText", "keyEchoesStem", "keyInStem", "keyNotEntailed", "hedgeDistractor"]
          func defects(_ flags: [String]) -> [String] { flags.map(flagKey).filter { defectSet.contains($0) } }
          guard let c1 = await gen(hint: nil) else {
            appendLine(path, line(["article": sp.article, "section": sp.no, "fact": fact.statement, "error": "generation failed"])); continue
          }
          var b = build(c1, page: sp.text, factQuote: fact.quote)
          var (flags, opts) = await check(b)
          var regen = false; var firstDefects: [String] = []; var droppedStem: Any = NSNull()
          let d1 = defects(flags)
          if !d1.isEmpty {
            firstDefects = d1; droppedStem = c1.stem
            for d in Set(d1) { st.regenReason[d, default: 0] += 1 }
            var whys: [String] = []
            let dmed = median(b.distractors.map { norm($0).count })
            if d1.contains("keyTooLong") { whys.append("the correct option was far longer than the distractors; write it as a short paraphrase of at most \(max(20, Int(1.3 * Double(dmed)))) characters and keep all four options between 20 and 70 characters") }
            if d1.contains("trueDistractor") { whys.append("a wrong option could also be correct per the text; make the distractors clearly false") }
            if d1.contains("equivalentDistractor") { whys.append("a distractor said nearly the same as the correct option; make each distractor clearly different in meaning") }
            if d1.contains("mentionsText") { whys.append("never write 'der Text', 'laut Text' or 'die Beschreibung'") }
            if d1.contains("keyEchoesStem") || d1.contains("keyInStem") { whys.append("the question contained the answer; the answer must add the new information") }
            if d1.contains("keyNotEntailed") { whys.append("the correct option must use the words of the supporting quote (\(fact.quote))") }
            if d1.contains("hedgeDistractor") { whys.append("no option may contain ebenfalls, auch, andere, teilweise, nur in bestimmten, nicht direkt") }
            let hint = "A previous attempt (question: \(c1.stem)) was rejected: " + whys.joined(separator: "; ") + "."
            if let c2 = await gen(hint: hint) {
              regen = true; st.regenerated += 1
              b = build(c2, page: sp.text, factQuote: fact.quote)
              (flags, opts) = await check(b)
            } else { st.regenFailed += 1; flags.append("regenFailed") }
          }
          let acc = isAccepted(flags)
          st.cards += 1; if acc { st.accepted += 1; if !isClean(flags) { st.review += 1 } }
          for f in Set(flags.map(flagKey)) { st.flagCount[f, default: 0] += 1 }
          for l in logs { st.add(l, sec: secId) }
          mcqs.append(McqRec(sec: sp, para: fact.para, accepted: acc, clean: acc && isClean(flags)))
          let optJSON: [[String: Any]] = opts.map { ["text": $0.text, "isKey": $0.isKey, "verdict": $0.verdict, "quote": $0.quote, "supported": $0.supported, "secondChance": $0.second] }
          appendLine(path, line([
            "article": sp.article, "section": sp.no, "sectionRef": "§\(sp.no)", "para": "¶\(fact.para)", "heading": sp.heading, "fact": fact.statement, "factQuote": fact.quote, "flashcardBack": fc.back, "stem": b.stem, "options": b.options,
            "correctIndex": b.correctIndex, "optionVerdicts": optJSON, "explanation": b.explanation, "flags": flags, "accepted": acc, "review": acc && !isClean(flags), "regenerated": regen,
            "firstDefects": firstDefects, "droppedStem": droppedStem,
            "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] }, "tokens": logs.map { ["call": $0.name, "in": $0.tin, "out": $0.tout] },
            "totalMs": logs.reduce(0) { $0 + $1.ms }]))
          say("mcq \(secId) card \(st.cards) regen=\(regen) flags=\(flags)")
        }
        say("mcq \(secId) done, section ms \(st.secMs[secId] ?? 0)")
      }
      st.wallMs = Int(Date().timeIntervalSince(t0) * 1000); report["mcq"] = st
      report["mcq"]!.regenReason["_downgradedVerdicts"] = downgraded
      report["mcq"]!.regenReason["_secondChanceRescued"] = secondRescued
      report["mcq"]!.regenReason["_secondChanceFailed"] = secondFailed
      for (k, v) in verdictCount { report["mcq"]!.regenReason["_verdict_" + k] = v }
    }

    // ---------------- 6c map-reduce summaries ----------------
    var sumSt = Stats(); var sumBullets = 0, sumBulletsLow = 0, sumDup = 0, sumAdded = 0, sumRefIssues = 0
    var sumCoverage: [String] = []
    if modes.contains("sum") {
      let path = "\(out)/summaries.jsonl"; try? "".write(toFile: path, atomically: true, encoding: .utf8)
      let t0 = Date()
      for article in Array(Set(secs.map { $0.article })).sorted() {
        var flat: [(sec: String, text: String)] = []
        var mapMs = 0
        for sp in secs where sp.article == article {
          let secId = sp.article + "-" + sp.no
          let r = await call(SectionBullets.self, instructions: "You summarise a textbook section in \(lang), from the text only. Two or three short bullets, one sentence each. Prefer definitions, causes and rules. No references, no section numbers.",
                             prompt: "Section title: \(sp.heading)\n\nSection:\n\n\(sp.text)\n\nSummarise in 2 to 3 bullets in \(lang).")
          sumSt.add(CallLog(name: "mapSummary", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId); mapMs += r.ms
          var bl: [String] = []
          if let v = r.value { bl = v.bullets.map { norm($0) } } else { sumSt.errors += 1 }
          let pw = Set(words(sp.text)); var low = 0
          for b in bl { let kw = words(b); if !kw.isEmpty && Double(kw.filter { !pw.contains($0) }.count) / Double(kw.count) > 0.5 { low += 1 } }
          sumBullets += bl.count; sumBulletsLow += low
          for b in bl { flat.append((sp.no, b)) }
          appendLine(path, line(["stage": "map", "article": article, "section": sp.no, "sectionRef": "§\(sp.no)", "history": sp.history, "bullets": bl.map { $0 + " (§\(sp.no))" }, "lowOverlapBullets": low,
                                 "ms": r.ms, "tokens": ["in": r.tokensIn, "out": r.tokensOut], "error": r.error ?? NSNull()]))
          say("sum map \(secId) \(bl.count) bullets \(r.ms) ms")
        }
        let numbered = flat.enumerated().map { "\($0.offset + 1). \($0.element.text)" }.joined(separator: "\n")
        let r = await call(Combined.self, instructions: "You combine section summaries into one article summary in \(lang), from the given bullets only. Six to ten bullets. Merge bullets that say the same thing into one; never repeat a statement. Cover definitions, causes and rules of every part of the article, not only the first sections. No references in the text. Give for every bullet the numbers of the input bullets it is based on.",
                           prompt: "Article \(article). Numbered section bullets:\n\n\(numbered)\n\nCombine them into 6 to 10 summary bullets for the whole article, in \(lang). Merge bullets that say the same thing. Cover every part of the article. For every bullet give the source bullet numbers.")
        sumSt.add(CallLog(name: "combine", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: article + "-combine")
        struct Item { var text: String; var secs: Set<String>; var added: Bool }
        var items: [Item] = []; var bad = 0
        if let v = r.value {
          for it in v.items {
            let srcs = Set(it.sources.filter { $0 >= 1 && $0 <= flat.count }.map { flat[$0 - 1].sec })
            if srcs.isEmpty { bad += 1 }
            items.append(Item(text: norm(it.text), secs: srcs, added: false))
          }
        } else { sumSt.errors += 1 }
        // near-duplicate bullets: merged in code (later one dropped, its sources joined into the earlier)
        var dedup: [Item] = []; var dups = 0
        for it in items {
          if let k = dedup.firstIndex(where: { overlapFrac($0.text, it.text) >= 0.6 }) { dedup[k].secs.formUnion(it.secs); dups += 1 } else { dedup.append(it) }
        }
        // at least one bullet per non-history section: add that section's first map bullet if no combined bullet cites it
        var added = 0
        for sp in secs where sp.article == article && !sp.history {
          if !dedup.contains(where: { $0.secs.contains(sp.no) }), let f = flat.first(where: { $0.sec == sp.no }) {
            dedup.append(Item(text: f.text, secs: [sp.no], added: true)); added += 1
          }
        }
        sumDup += dups; sumAdded += added; sumRefIssues += bad
        let outB = dedup.map { $0.text + ($0.secs.isEmpty ? "" : " (" + $0.secs.sorted().map { "§\($0)" }.joined(separator: ", ") + ")") }
        let cited = Set(dedup.flatMap { $0.secs })
        let nonHist = secs.filter { $0.article == article && !$0.history }.map { $0.no }
        sumCoverage.append("\(article): non-history sections cited \(nonHist.filter { cited.contains($0) }.count)/\(nonHist.count); all sections cited \(secs.filter { $0.article == article && cited.contains($0.no) }.count)/\(secs.filter { $0.article == article }.count); combine bullets \(items.count) -> \(items.count - dups) after dedup (+\(added) added from map) = \(dedup.count)")
        appendLine(path, line(["stage": "combine", "article": article, "bullets": outB, "bulletCount": outB.count, "combinedRaw": items.count, "duplicatesMerged": dups, "addedForCoverage": added,
                               "addedBullets": dedup.filter { $0.added }.map { $0.text }, "bulletsWithoutValidSource": bad, "inputBullets": flat.count,
                               "ms": r.ms, "mapMs": mapMs, "tokens": ["in": r.tokensIn, "out": r.tokensOut], "error": r.error ?? NSNull()]))
        say("sum combine \(article): \(outB.count) bullets \(r.ms) ms")
      }
      sumSt.wallMs = Int(Date().timeIntervalSince(t0) * 1000); report["sum"] = sumSt
    }

    // ---------------- coverage ----------------
    func coverage(_ keys: [(String, String, Int)], label: String) -> (String, [String: Any]) {
      var cov = Set<String>(); for k in keys { cov.insert("\(k.0)-\(k.1)-\(k.2)") }
      var md = "| section | words | paragraphs | paras > 60 words | covered (> 60 w) | covered (all) |\n|---|---|---|---|---|---|\n"
      var tb = 0, cb = 0, ta = 0, ca = 0; var js: [String: Any] = [:]
      for sp in secs {
        let big = sp.paras.filter { $0.words > 60 }
        let cb1 = big.filter { cov.contains("\(sp.article)-\(sp.no)-\($0.no)") }.count
        let ca1 = sp.paras.filter { cov.contains("\(sp.article)-\(sp.no)-\($0.no)") }.count
        md += "| \(sp.article)-\(sp.no) \(sp.heading) | \(sp.words) | \(sp.paras.count) | \(big.count) | \(cb1) | \(ca1) |\n"
        tb += big.count; cb += cb1; ta += sp.paras.count; ca += ca1
        js["\(sp.article)-\(sp.no)"] = ["paras": sp.paras.count, "big": big.count, "coveredBig": cb1, "coveredAll": ca1,
                                         "uncoveredBig": big.filter { !cov.contains("\(sp.article)-\(sp.no)-\($0.no)") }.map { "¶\($0.no)" }]
      }
      md += "| **total (\(label))** | | \(ta) | \(tb) | **\(cb)/\(tb)** | \(ca)/\(ta) |\n"
      js["_total"] = ["big": tb, "coveredBig": cb, "paras": ta, "coveredAll": ca]
      return (md, js)
    }
    var covMd = ""; var covJson: [String: Any] = [:]
    if report["flash"] != nil {
      let (m, j) = coverage(fcs.filter { $0.accepted }.map { ($0.sec.article, $0.sec.no, $0.fact.para) }, label: "accepted flashcards")
      covMd += "### 6a flashcards (accepted), coverage per paragraph\n\n" + m + "\n"; covJson["flash"] = j
      let (m2, j2) = coverage(fcs.map { ($0.sec.article, $0.sec.no, $0.fact.para) }, label: "all generated flashcards")
      covJson["flashAllGenerated"] = j2; _ = m2
    }
    if report["mcq"] != nil {
      let (m, j) = coverage(mcqs.filter { $0.accepted }.map { ($0.sec.article, $0.sec.no, $0.para) }, label: "accepted MCQ")
      covMd += "### 6b MCQ (accepted), coverage per paragraph\n\n" + m + "\n"; covJson["mcq"] = j
    }
    // run 5 comparison: paragraph coverage of its accepted flashcards (para tags were stored per card)
    var r5Cov = ""
    if !run5.isEmpty, let txt = try? String(contentsOfFile: run5 + "/flashcards.jsonl", encoding: .utf8) {
      var keys: [(String, String, Int)] = []
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any], (o["accepted"] as? Bool) == true,
              let ar = o["article"] as? String, let se = o["section"] as? String, let p = o["para"] as? String, let n = Int(p.replacingOccurrences(of: "¶", with: "")) else { continue }
        keys.append((ar, se, n))
      }
      let (m, j) = coverage(keys, label: "run 5 accepted flashcards")
      r5Cov = "### run 5 flashcards (accepted), same measure\n\n" + m + "\n"; covJson["run5flash"] = j
    }
    if let d = try? JSONSerialization.data(withJSONObject: covJson, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/coverage.json")) }

    // ---------------- summary ----------------
    func block(_ name: String, _ s: Stats) -> String {
      let rates = s.flagCount.sorted { $0.key < $1.key }.map { "  - \($0.key): \(pct($0.value, s.cards))" }.joined(separator: "\n")
      let reg = s.regenReason.filter { !$0.key.hasPrefix("_") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
      let calls = s.perCall.sorted { $0.key < $1.key }.map { "\($0.key) \(median($0.value)) (n=\($0.value.count))" }.joined(separator: ", ")
      let extra = s.regenReason.filter { $0.key.hasPrefix("_") }.sorted { $0.key < $1.key }.map { "\($0.key.dropFirst())=\($0.value)" }.joined(separator: ", ")
      let secMsAll = s.secMs.filter { !$0.key.hasSuffix("combine") }.values.map { $0 }
      let tpa = s.accepted == 0 ? "n/a" : "\((s.tokIn + s.tokOut) / s.accepted) (in \(s.tokIn / s.accepted), out \(s.tokOut / s.accepted))"
      return """
      ## \(name)

      - facts: \(s.facts) (quote not verbatim: \(s.factQuoteBad), rejected by code: \(s.factsRejected)); cards: \(s.cards); accepted (no hard flag): \(pct(s.accepted, s.cards)), of which review (soft flag): \(s.review); call errors: \(s.errors)
      - flag rates (share of cards; a card can carry several):
      \(rates.isEmpty ? "  - none" : rates)
      - regenerated: \(s.regenerated), regeneration failed: \(s.regenFailed); first-attempt defects by reason: \(reg.isEmpty ? "none" : reg)
      - \(extra.isEmpty ? "no verdict stats" : "option verdicts / downgrades: " + extra)
      - median ms per call: \(calls)
      - ms per section: mean \(secMsAll.isEmpty ? 0 : secMsAll.reduce(0, +) / secMsAll.count), median \(median(secMsAll)), total wall \(s.wallMs) ms (per-section list in timing-sections.json)
      - tokens (in/out): \(s.tokIn)/\(s.tokOut); per accepted card (in+out): \(tpa)
      - ms per accepted card: \(s.accepted == 0 ? "n/a" : "\(s.secMs.values.reduce(0, +) / s.accepted)")
      """
    }
    var md = "# pipeline summary (run 6, \(lang))\n\n- input: \(input) (\(secs.count) sections: \(Set(secs.map { $0.article }).sorted().joined(separator: ", ")))\n\n"
    if let s = report["flash"] { md += block("6a flashcards", s) + "\n\n" }
    if let s = report["mcq"] { md += block("6b mcq (from accepted flashcards only)", s) + "\n\n" }
    if let f = report["flash"], let m = report["mcq"] {
      let fm = (f.tokIn + f.tokOut), mm = (m.tokIn + m.tokOut)
      md += "## 6a vs 6b\n\n| metric | flashcards | mcq (from accepted flashcards) |\n|---|---|---|\n| cards | \(f.cards) | \(m.cards) |\n| accepted | \(f.accepted) | \(m.accepted) |\n| of which review | \(f.review) | \(m.review) |\n| acceptance rate | \(f.cards == 0 ? 0 : f.accepted * 100 / f.cards)% | \(m.cards == 0 ? 0 : m.accepted * 100 / m.cards)% |\n| tokens per accepted card (own stage) | \(f.accepted == 0 ? 0 : fm / f.accepted) | \(m.accepted == 0 ? 0 : mm / m.accepted) |\n| tokens per accepted MCQ incl. its flashcard stage | | \(m.accepted == 0 ? 0 : (fm + mm) / m.accepted) |\n| total wall ms | \(f.wallMs) | \(m.wallMs) |\n\n"
    }
    md += "## coverage per paragraph (cards from the paragraph / paragraphs over 60 words)\n\n" + covMd + r5Cov
    if report["sum"] != nil {
      let s = sumSt
      md += "## 6c summaries (map-reduce + dedup + per-section coverage)\n\n- map calls: \(s.perCall["mapSummary"]?.count ?? 0), median ms \(median(s.perCall["mapSummary"] ?? [])); combine calls: \(s.perCall["combine"]?.count ?? 0), median ms \(median(s.perCall["combine"] ?? []))\n- section bullets: \(sumBullets), with >50% content words missing from the section: \(sumBulletsLow)\n- near-duplicate combined bullets merged in code: \(sumDup); bullets added from map for uncited non-history sections: \(sumAdded); combined bullets without a valid source: \(sumRefIssues)\n- " + sumCoverage.joined(separator: "\n- ") + "\n- tokens (in/out): \(s.tokIn)/\(s.tokOut); total wall \(s.wallMs) ms; call errors \(s.errors)\n- ms per section (map): " + s.secMs.filter { !$0.key.hasSuffix("combine") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ") + "\n\n"
    }
    var timing: [String: Any] = [:]
    for (k, s) in report { timing[k] = s.secMs.mapValues { $0 }.merging(s.secTok.reduce(into: [String: Int]()) { $0[$1.key + ".tokIn"] = $1.value.0; $0[$1.key + ".tokOut"] = $1.value.1 }) { a, _ in a } }
    if let d = try? JSONSerialization.data(withJSONObject: timing, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/timing-sections.json")) }
    try? md.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    say(md)
  }
}
