// Probe run 7 (German): flashcards + summaries only (MCQ stays opt-in, not in this run). Builds on run 6.
// 7a: named-term sentences are mandatory facts outside the per-paragraph cap (code regex); condition sentences outrank
// history at the cap; fronts unique per article (regenerate the later one) and in question form (bare term rejected);
// terms of the fact quote must survive into the back (termsLost, regenerate once); back dedup by >=70% content-word
// overlap; backTooLong is soft when the back faithfully quotes a named-term sentence.
// 7c: strip formula debris + source numbers "(1, 3, 4)" in code; combine sees the section excerpts (the facts' quotes);
// "entweder/oder" merges rejected; each combined bullet must share >=2 content words with one quote of its cited
// section, else dropped and replaced by that section's map bullet.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-r7.swift -o $TMPDIR/pipeline-probe-r7
// Run:   $TMPDIR/pipeline-probe-r7 <dir of sections> <out dir> German [flash,sum]
import Foundation
import FoundationModels

@Generable struct Fact: Codable {
  @Guide(description: "quote verbatim from the text, in the original German: one exact contiguous passage (one or two sentences, never a heading, list title or recap line) copied character for character that states the fact; do not copy the [¶N] tags") var quote: String
  @Guide(description: "the fact as one short, self-contained German sentence that names its subject explicitly, derived from the quote") var statement: String
}
@Generable struct FactList: Codable {
  @Guide(description: "distinct facts from the text, each about a different thing, spread over the whole text", .maximumCount(8)) var facts: [Fact]
}
@Generable struct Flashcard: Codable {
  @Guide(description: "front of the flashcard: a question in German that starts with or contains a W-question word (Was, Wie, Wann, Wo, Warum, Wodurch, Womit, Welcher/Welche/Welches, Welche Rolle, In welcher Weise) and names its subject explicitly; never a bare term") var front: String
  @Guide(description: "back of the flashcard: a short, precise answer of one or two sentences, from the text, no sentence repeated, all technical terms and numbers with units of the supporting quote present in the answer") var back: String
  @Guide(description: "quote verbatim from the text: one exact contiguous passage copied character for character that supports the back") var supportingQuote: String
}
@Generable struct SectionBullets: Codable {
  @Guide(description: "two or three short summary bullets of the section, one sentence each", .minimumCount(2), .maximumCount(3)) var bullets: [String]
}
@Generable struct CombinedItem: Codable {
  @Guide(description: "one summary bullet of the article in German, one or two sentences, no references, no bullet numbers like (1, 3, 4); never merge two statements with 'entweder ... oder' when both hold") var text: String
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
  var merged: [(String, [String])] = []
  var carry: [String] = []
  for s in secs {
    let body = carry + s.1
    if norm(body.joined(separator: " ")).count < 250 { carry = body; continue }
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

// ---- run 7 ----
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
      // sentence-splitting needs the source punctuation: "bzw.", "z. B.", "u. a." would end a sentence otherwise
      var body = String(t[r.upperBound...])
      for d in ["bzw.", "z. B.", "z.B.", "u. a.", "d. h.", "ca.", "vs.", "usw.", "etc.", "vgl.", "d. h."] { body = body.replacingOccurrences(of: d, with: d.replacingOccurrences(of: ".", with: "∯")) }
      body = norm(body).replacingOccurrences(of: "∯", with: ".")
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
/// sentences split at [.!?] + whitespace; "bzw.", "z. B." etc. are protected by the ∯ marker set in cleanSection
func splitSentences(_ s: String) -> [String] {
  s.replacingOccurrences(of: #"(?<=[.!?∯])\s+"#, with: "\n", options: .regularExpression).components(separatedBy: "\n")
}
func stems(_ s: String) -> Set<String> { Set(words(s).map { String($0.prefix(5)) }) }
func shared(_ a: String, _ b: String) -> Int { stems(a).intersection(stems(b)).count }
func overlapFrac(_ a: String, _ b: String) -> Double {
  let wa = stems(a), wb = stems(b); let m = min(wa.count, wb.count)
  return m == 0 ? 0 : Double(wa.intersection(wb).count) / Double(m)
}
/// >=70% of the shorter side's content words (stemmed) appear in the other: paraphrase + verbatim repeats
func contentOverlap(_ a: String, _ b: String) -> Double {
  let wa = Set(stems(a)), wb = Set(stems(b)); let m = min(wa.count, wb.count)
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

/// duplicate sentences of a back removed in code, exact and by >=70% content-word overlap with an earlier sentence
func dedupSentences(_ s: String) -> (String, Bool) {
  let parts = splitSentences(norm(s))
  var kept: [String] = []; var dropped = false
  for p in parts {
    let k = p.lowercased().trimmingCharacters(in: .punctuationCharacters)
    if k.isEmpty { continue }
    if kept.contains(where: { contentOverlap($0, p) >= 0.7 }) { dropped = true; continue }
    kept.append(p)
  }
  return (kept.joined(separator: " "), dropped || kept.count != parts.count)
}

// ---- run 7 rules: named terms, conditions vs history, question fronts, term survival ----
let namedTermRe = rx(#"(spricht man von|sogenannte[rns]?|sog\.\s|nennt man|(?:so |es )?heißt|bezeichnet man (als|zu)|(?:wird|werden)\s[^.]{0,60}?(?:\ban\b|als)?[^.]{0,40}?genannt)"#)
/// a term in parentheses after a definition: "(Fachbegriff)", "(labile Schichtung)", "(Ac lenticularis)".
/// The run 6 miss list (Thermikschlauch ¶7, Föhnmauer/Föhnfenster ¶58, Föhnsturm ¶59, Totluft ¶62) is covered by the patterns.
let parenTermRe = rx(#"\(([A-ZÄÖÜ][^()]{2,50})\)"#)
/// words that are never a named term (past participles and verbs caught by loose pattern matches)
let notTerm: Set<String> = ["abgekühlt","abgeregnet","abgetragen","abgelöst","angegeben","beschrieben","bezeichnet","benannt","entdeckt","eingemischt","erwärmt","geändert","genutzt","gemessen","gestört","getragen","gebracht","geworden","gezeigt","geführt","gehalten","haben","hat","kommt","ermöglicht","erreicht","entsteht","entstanden","gebildet","bildet","verursacht","verändert","verbessert","verbreitet","verschiebung","unsichtbar","abgegeben","aufgetreten","ausgebildet","existiert","gewählt","worden"]
/// the term is the last capitalised run before the end of the pattern's clause (up to the first comma/semicolon/colon or sentence end)
func extractTerm(_ s: String, upTo endIdx: Int) -> String {
  let chars = Array(s)
  let rest = String(chars[0..<min(endIdx, chars.count)])
  let cut = rest.lastIndex(where: { ",;:".contains($0) })
  let zone = cut.map { String(rest[rest.index(after: $0)...]) } ?? rest
  let caps = rx(#"[A-ZÄÖÜ][\wäöüß-]+(?: [a-zäöüß][\wäöüß-]+)*"#).matches(in: zone, range: NSRange(zone.startIndex..., in: zone)).compactMap { Range($0.range, in: zone).map { String(zone[$0]) } }
  return caps.last ?? ""
}
let condRe = rx(#"\b(bei\w*|wenn|nach\w*|sobald|falls|sofern)\b"#)
let histSentRe = rx(#"(\b(1[5-9]\d\d|20[0-2]\d)\b|wurde \w+ (beschrieben|erwähnt|entdeckt|eingeführt)|\b(?:nach|von|durch) [A-ZÄÖÜ][a-zäöüß]+ (beschrieben|entdeckt|benannt)|Geschichte|Historie|erstmals)"#)
let stopLower: Set<String> = ["der","die","das","des","dem","den","ein","eine","einen","einem","einer","und","oder","aber","doch","denn","weil","wenn","als","wann","wie","wer","was","werde","werden","wurde","worden","sind","sein","ist","bist","sei","seien","war","waren","hat","hatte","hatten","habe","haben","kann","können","konnte","muss","müssen","musste","darf","soll","sollen","will","mag","bei","nach","aus","von","zu","zur","zum","im","am","an","auf","für","mit","ohne","um","durch","gegen","über","unter","vor","hinter","zwischen","in","innerhalb","außerhalb","dass","damit","dadurch","deshalb","daher","dann","auch","nur","schon","noch","bereits","etwa","circa","sehr","mehr","weniger","sowie","sowohl","bzw","etc","dh","zb","usw","andere","anderen","anderer","anderes","anderem","gleiche","gleicher","selbe","selber","solche","solcher","solches","dieser","diese","dieses","diesen","diesem","jener","jene","jenes","welcher","welche","welches","welchen","welchem","würde","würden","ließe","lässt","lassen","gab","gibt","wurden","beim","vom","ungefähr","knapp","rund","gut","viel","wenig","mehrere","alle","keine","kein","manche","folgende","folgendem","folgenden","nämlich","zwar","jedoch","allerdings","hingegen","dagegen","ebenso","ebenfalls","somit","folglich","also","spricht","sprechen","nennt","heißen","heißt","genannt","bezeichnet","bedeutet","beinhaltet","enthalten","enthält","dabei","danach","wobei","indem","indes","solange","sobald","nachdem","bevor","während","trotz","wegen","halber","zunächst","zudem","hinaus","etwa"]
let sentenceStartCaps: Set<String> = ["Der","Die","Das","Ein","Eine","Kein","Keine","Manche","Mehrere","Alle","Wenn","Nach","Weil","Auch","Dabei","Dann","Hier","Dort","Zum","Zur","Am","Im","Auf","Von","Aus","Mit","Ohne","Vor","Über","Unter","Durch","Gegen","Zwischen","Bei","Ab","Bis","Seit","Dies","Diese","Dieser","Dieses","Welche","Welcher","Folgende","Folgender","Zwar","Jedoch","Dagegen","Ebenso","Somit","Also","Nur","Schon","Noch","Bereits","Etwa","Sehr","Mehr","Weniger","Gut","Viel","Wenig","Oft","Immer","Nie","Niemals","Ist","Sind","War","Waren","Hat","Hatte","Haben","Kann","Muss","Darf","Soll","Wird","Werden","Wurde","Demnach","Weitere","Speichert","Leitet","Beträgt","Da","Gerade","Pflanzen","Solche","Dieser"]
/// German verbs in 3rd person (always lower case mid-sentence): never a technical term
let verbRe = rx(#"^(?:ver|be|zer|ent|er|ab|an|auf|aus|bei|ein|mit|nach|vor|zu|zur|über|unter)[a-zäöüß-]{2,}(?:en|et|e|st|est)$"#)
/// technical terms of a text: capitalised nouns/compounds (>=4 letters, not sentence-initial, not a verb) and numbers with units
func techTerms(_ s: String) -> [String] {
  var out: [String] = []
  for m in rx(#"\b[A-ZÄÖÜ][a-zäöüß]+(?:-[A-Za-zäöüß]+)*"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
    guard let r = Range(m.range, in: s) else { continue }
    let t = String(s[r])
    // skip words at the start of a sentence (or after ". "): likely verbs/function words, not terms
    let pre = s[..<r.lowerBound].trimmingCharacters(in: .whitespaces)
    if pre.isEmpty || pre.hasSuffix(".") || pre.hasSuffix("!") || pre.hasSuffix("?") || pre.hasSuffix(":") { continue }
    if t.count >= 4 && !stopLower.contains(t.lowercased()) && !sentenceStartCaps.contains(t) && !has(verbRe, t.lowercased()) { out.append(t.lowercased()) }
  }
  for m in rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|l/min|kg|g/l|g/kg|°|/100\s*m|je 100 m)"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
    guard let r = Range(m.range, in: s) else { continue }
    out.append(norm(String(s[r])).lowercased())
  }
  return Array(Set(out))
}
/// question form of a front (German W-question), or an explicit cue with context
let questionRe = rx(#"(^|\?!\s|\.\s)(Was|Wie|Wann|Wo|Warum|Weshalb|Wodurch|Womit|Welcher|Welche|Welches|Welchen|Welchem|Inwiefern|In welchem|Auf welche|Unter welchen|Mit welcher|Durch welche|Wie viele|Wie schnell|Wie groß|Wie hoch|Wie tief)"#)
func isQuestion(_ s: String) -> Bool { has(questionRe, s) }
let formulaDebrisRe = rx(#"[αβγδεζηθλμνξπρστφψω]{3,}|[=+\-*/^≤≥<>]{2,}"#)
/// "(1, 3, 4)" / "(§3, §7)" style source-number debris
let srcNumRe = rx(#"\(\s*\d{1,2}([;,]\s*\d{1,2})+\s*\)|\(?\s*§\d+([;,]\s*§\d+)+\s*\)?"#)
func stripDebris(_ s: String) -> (String, Bool) {
  var r = norm(s); var changed = false
  let sr = srcNumRe.stringByReplacingMatches(in: r, range: NSRange(r.startIndex..., in: r), withTemplate: "")
  if sr != r { r = norm(sr); changed = true }
  if has(formulaDebrisRe, r) { return ("", true) }
  return (r.trimmingCharacters(in: .whitespacesAndNewlines), changed)
}

struct CallLog { var name: String; var ms: Int; var tin: Int; var tout: Int }
func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : "\(n)/\(d) (\(Int(Double(n) * 100 / Double(d)))%)" }
func flagKey(_ f: String) -> String { f.split(separator: ":").first.map(String.init) ?? f }

struct Stats {
  var facts = 0, factQuoteBad = 0, factsRejected = 0, cards = 0, accepted = 0, review = 0, regenerated = 0, regenFailed = 0, errors = 0, tokIn = 0, tokOut = 0, wallMs = 0, droppedDupFront = 0
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

// ---- 7a facts: proportional to length; named-term sentences mandatory outside the cap; conditions outrank history ----
struct FactRec { var statement: String; var quote: String; var para: Int; var verbatim: Bool; var guessed: Bool; var namedTerm: Bool; var term: String }

/// named-term hits of a paragraph, split at sentence ends: (term, sentence)
func namedTermSentences(_ p: Para) -> [(term: String, sent: String)] {
  let sents = splitSentences(p.text)
  var out: [(String, String)] = []
  for s in sents where !s.trimmingCharacters(in: .whitespaces).isEmpty {
    var term = ""
    // one hit per pattern type: the term stands AFTER "spricht man von"/"nennt man"/"sog."/"sogenannte"/"bezeichnet man als",
    // BEFORE "wird … genannt" and before/after "heißt" depending on word order
    for m in namedTermRe.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
      guard let r = Range(m.range, in: s) else { continue }
      let pat = String(s[r]).lowercased()
      var t = ""
      if pat.hasSuffix("genannt") || pat == "heißt" || pat == "heisst" {
        t = extractTerm(String(s[s.startIndex..<r.lowerBound]), upTo: s.distance(from: s.startIndex, to: r.lowerBound))
      } else {
        let after = String(s[r.upperBound...])
        t = extractTerm(after, upTo: after.count)
      }
      if !t.isEmpty { term = t; break }
    }
    if term.isEmpty, let m = parenTermRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range(at: 1), in: s) { term = String(s[r]) }
    term = term.trimmingCharacters(in: CharacterSet(charactersIn: " „\"'“”·.")).trimmingCharacters(in: .whitespaces)
    if !term.isEmpty && term.count >= 3 && !notTerm.contains(term.lowercased()) { out.append((term, s)) }
  }
  return out
}

func extractFacts(_ sp: Sec, lang: String, stats: inout Stats, factsPath: String, termHitsPath: String) async -> [FactRec] {
  let secId = sp.article + "-" + sp.no
  let big = sp.paras.filter { $0.words > 60 }
  let n = min(8, max(1, Int((Double(sp.words) / 80).rounded()), big.count))
  let spN = norm(sp.text)
  var recs: [FactRec] = []
  var rejected: [[String: Any]] = []
  func consider(_ f: Fact, named: Bool, term: String) {
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
      if !named && recs.filter({ $0.para == p && !$0.namedTerm }).count >= 2 { why = "paraCap" }
      else if recs.contains(where: { $0.para == p && overlapFrac($0.statement, st) >= 0.7 }) { why = "duplicate" }
      else if named, let k = recs.firstIndex(where: { $0.para == p && overlapFrac($0.quote, q) >= 0.7 }) { recs[k] = FactRec(statement: st, quote: q, para: p, verbatim: verb, guessed: g, namedTerm: true, term: term); return }
      else { recs.append(FactRec(statement: st, quote: q, para: p, verbatim: verb, guessed: g, namedTerm: named, term: term)) }
    }
    if !why.isEmpty { rejected.append(["quote": q, "statement": st, "why": why]); stats.factsRejected += 1 }
  }
  // rule 2: when the cap is reached, condition sentences (bei/wenn/nach/sobald) outrank history/biography sentences
  func rank(_ f: Fact) -> Int {
    let q = f.quote
    var r = 0
    if has(condRe, q) { r += 2 }
    if has(histSentRe, q) || sp.history && has(histSentRe, q) { r -= 2 }
    return r
  }
  let ins = "You extract the key facts of a textbook passage in \(lang), from the text only. Every fact must stand on its own: name the subject explicitly, never write 'diese', 'solche' or 'dies' without saying what is meant."
  let fp = "Section title: \(sp.heading)\n\nText (the [¶N] tags number the paragraphs; never copy them):\n\n\(sp.tagged)\n\nList \(n) distinct facts, spread over the whole text: every paragraph of more than 60 words must be used for at least one fact, no paragraph for more than two. Per fact first copy the verbatim German quote (one or two sentences) from the text, then write the statement in \(lang) from it. Prefer definitions, causes, conditions and numeric rules over history and attribution; among competing facts prefer ones that state a condition ('bei …', 'wenn …', 'nach …'). Never use headings, list titles, recap lines (Zusammenfassung, Merke), figures, tables or sentences that end in a colon as facts; skip garbled formulas."
  for attempt in 0..<2 {
    let r = await call(FactList.self, instructions: ins, prompt: attempt == 0 ? fp : fp + "\nYou must list \(n) facts, each from a different sentence of the text.")
    stats.add(CallLog(name: attempt == 0 ? "facts" : "factsRetry", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId)
    guard let v = r.value else { stats.errors += 1; continue }
    for f in v.facts.sorted(by: { rank($0) > rank($1) }) { consider(f, named: false, term: "") }
    if recs.count * 2 >= n || sp.words < 60 { break }
  }
  // paragraphs over 60 words still without a fact: one targeted call each
  for p in big where !recs.contains(where: { $0.para == p.no }) {
    let k = min(2, max(1, p.words / 80))
    let r = await call(FactList.self, instructions: ins, prompt: "Section title: \(sp.heading)\n\nParagraph:\n\n\(p.text)\n\nList \(k) fact(s) from this paragraph. Per fact first copy the verbatim German quote (one or two sentences), then write the statement in \(lang). Never use sentences that end in a colon, headings or recap lines.")
    stats.add(CallLog(name: "factsPara", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId)
    guard let v = r.value else { stats.errors += 1; continue }
    for f in v.facts.prefix(k).sorted(by: { rank($0) > rank($1) }) { consider(f, named: false, term: "") }
  }
  // rule 1: every named-term sentence is a mandatory fact, outside the per-paragraph cap (code regex, no model needed for the hit itself)
  var hits: [[String: Any]] = []
  for p in sp.paras {
    for h in namedTermSentences(p) {
      let covered = recs.contains(where: { $0.para == p.no && norm(h.sent).contains(norm($0.quote)) })
      if !covered {
        let st = "Fachbegriff „\(h.term)“: \(norm(h.sent))"
        consider(Fact(quote: h.sent, statement: st), named: true, term: h.term)
      } else if let i = recs.firstIndex(where: { $0.para == p.no && norm(h.sent).contains(norm($0.quote)) }) {
        recs[i].namedTerm = true; recs[i].term = h.term
      }
      hits.append(["article": sp.article, "section": sp.no, "para": "¶\(p.no)", "term": h.term, "sentence": h.sent,
                   "becameCard": recs.contains(where: { $0.para == p.no && $0.namedTerm && $0.term.lowercased() == h.term.lowercased() })])
    }
  }
  for h in hits { appendLine(termHitsPath, line(h)) }
  for f in recs {
    stats.facts += 1; if !f.verbatim { stats.factQuoteBad += 1 }
    appendLine(factsPath, line(["article": sp.article, "section": sp.no, "heading": sp.heading, "statement": f.statement, "quote": f.quote, "quoteVerbatim": f.verbatim, "para": "¶\(f.para)", "paraGuessed": f.guessed, "namedTerm": f.namedTerm, "term": f.term, "target": n]))
  }
  for r in rejected { appendLine(factsPath, line(["article": sp.article, "section": sp.no, "rejectedFact": r])) }
  return recs
}

let softFlags: Set<String> = ["prefixStripped", "unsupportedVerdict", "quoteNotVerbatim", "stemDemonstrative", "verdictError", "backDeduped", "frontDemonstrative", "paraGuessed", "backTooLongQuote"]
func isAccepted(_ flags: [String]) -> Bool { flags.allSatisfy { softFlags.contains(flagKey($0)) } }
func isClean(_ flags: [String]) -> Bool { flags.allSatisfy { $0 == "prefixStripped" || $0 == "backDeduped" } }

struct FC { var sec: Sec; var fact: FactRec; var front: String; var back: String; var quote: String; var flags: [String]; var accepted: Bool }

@main struct Pipeline {
  static func main() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    let a = CommandLine.arguments
    let input = a[1], out = a[2], lang = a.count > 3 ? a[3] : "German"
    let modes = a.count > 4 ? a[4].components(separatedBy: ",") : ["flash", "sum"]
    let run6 = a.count > 5 ? a[5] : ""
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

    // ---------------- 7a flashcards ----------------
    if modes.contains("flash") {
      let path = "\(out)/flashcards.jsonl", fpath = "\(out)/facts-flash.jsonl", tpath = "\(out)/named-terms.jsonl"
      for p in [path, fpath, tpath] { try? "".write(toFile: p, atomically: true, encoding: .utf8) }
      var st = Stats(); let t0 = Date()
      let base = "You write flashcards from the given text only, in \(lang). Everything must be supported by the text. If the text contains a garbled formula, a lost symbol or an inconsistent number, do not build a card on it. Never ask about figures or tables. Write ONE flashcard about the given fact: the front is a QUESTION in German that starts with a W-question word (Was, Wie, Wann, Wo, Warum, Wodurch, Womit, Welche[r]) and names its subject explicitly, never a bare term and never 'diese Effekte', 'solche', 'dies' without saying what is meant; the back a short precise answer (one or two sentences, no sentence twice) in the wording of the text that keeps every technical term and every number with unit of the supporting quote; supportingQuote copied verbatim from the text."
      var frontsByArticle: [String: Set<String>] = [:]
      for sp in secs {
        let secId = sp.article + "-" + sp.no
        let fl = await extractFacts(sp, lang: lang, stats: &st, factsPath: fpath, termHitsPath: tpath)
        for fact in fl {
          var logs: [CallLog] = []
          func gen(hint: String?, avoid: [String]) async -> Flashcard? {
            var prompt = "Section title: \(sp.heading)\n\nText:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\n\nWrite one flashcard in \(lang) that tests exactly this fact. The front is a question ('Was…?', 'Wie…?', 'Wann…?', 'Warum…?') naming the subject of the section/fact explicitly."
            if !avoid.isEmpty { prompt += "\nFronts already used for this article, do not repeat or paraphrase them (write a question that asks for the detail that makes THIS fact different): " + avoid.joined(separator: " | ") }
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
            // rule 3: fronts in question form; a bare term is rejected
            if !norm(c.front).isEmpty && !isQuestion(c.front) && !(c.front.contains("?") && c.front.split(separator: " ").count >= 5) { flags.append("frontNotQuestion") }
            // rule 4: technical terms of the fact quote must survive into the back
            let lost = techTerms(fact.quote).filter { !norm(c.back).lowercased().contains($0) }
            if !lost.isEmpty { flags.append("termsLost:" + lost.prefix(6).joined(separator: ",")) }
            // rule 6: a long back that faithfully quotes a named-term sentence is review, not rejection
            let faithfulQuote = fact.namedTerm && (norm(c.back).lowercased().contains(norm(fact.quote).lowercased()) || contentOverlap(c.back, fact.quote) >= 0.85)
            if norm(c.back).count > 350 { flags.append(faithfulQuote ? "backTooLongQuote" : "backTooLong") }
            if !norm(c.back).isEmpty && norm(c.front).lowercased().contains(norm(c.back).lowercased()) { flags.append("backInFront") }
            if has(demoRe, c.front) { flags.append("frontDemonstrative") }
            return (c, flags)
          }
          let hardRegen: Set<String> = ["quoteNotVerbatim", "frontDemonstrative", "answerWordsMissing", "emptySide", "backStub", "backTooLong", "backInFront", "frontNotQuestion", "termsLost", "frontClash"]
          guard var c0 = await gen(hint: nil, avoid: []) else {
            appendLine(path, line(["article": sp.article, "section": sp.no, "fact": fact.statement, "error": "generation failed"])); continue
          }
          // rule 3: fronts unique per article; on a clash regenerate the later one once
          var frontClash = false
          if isQuestion(c0.front) {
            let used = frontsByArticle[sp.article] ?? []
            if used.contains(where: { contentOverlap($0, c0.front) >= 0.85 }) {
              frontClash = true
              if let c2 = await gen(hint: "The front collided with a card of the same article; ask for the detail that distinguishes this fact.", avoid: Array(used)) { c0 = c2 }
            }
          }
          var (c, flags) = checks(c0); var regen = false; var first: [String] = []
          if frontClash { first.append("frontClash") }
          let need = flags.map(flagKey).filter { hardRegen.contains($0) } + (frontClash ? ["frontClash"] : [])
          if !need.isEmpty {
            first = flags.isEmpty ? first : flags; for f in Set(need) { st.regenReason[f, default: 0] += 1 }
            var why = "the front must be a question ('Was…?', 'Wie…?', 'Wann…?', 'Warum…?') naming its subject (no bare term, no 'diese'/'solche'/'dies'), the quote copied exactly from the text, and the back must keep every technical term and number-with-unit of the supporting quote"
            if need.contains("termsLost") { why += " (missing here: " + ((flags.first { flagKey($0) == "termsLost" } ?? "").replacingOccurrences(of: "termsLost:", with: "")) + ")" }
            if let c2 = await gen(hint: "A previous attempt (front: \(c.front)) was rejected for: \(need.joined(separator: ", ")). " + why + ".", avoid: Array(frontsByArticle[sp.article] ?? [])) { regen = true; st.regenerated += 1; (c, flags) = checks(c2) } else { st.regenFailed += 1; flags.append("regenFailed") }
          }
          // after the single regeneration a still-clashing front is dropped (fronts stay unique per article)
          var dropped = false
          let usedNow = frontsByArticle[sp.article] ?? []
          if !usedNow.contains(where: { contentOverlap($0, c.front) >= 0.85 }) && isQuestion(c.front) { frontsByArticle[sp.article, default: []].insert(norm(c.front).lowercased()) }
          else if isQuestion(c.front) { dropped = true }
          let acc = isAccepted(flags) && !dropped
          st.cards += 1; if dropped { st.droppedDupFront += 1 }; if acc { st.accepted += 1; if !isClean(flags) { st.review += 1 } }
          for f in Set(flags.map(flagKey)) { st.flagCount[f, default: 0] += 1 }
          for l in logs { st.add(l, sec: secId) }
          fcs.append(FC(sec: sp, fact: fact, front: c.front, back: c.back, quote: c.supportingQuote, flags: flags, accepted: acc))
          appendLine(path, line(["article": sp.article, "section": sp.no, "sectionRef": "§\(sp.no)", "para": "¶\(fact.para)", "heading": sp.heading, "fact": fact.statement, "factQuote": fact.quote,
                                 "namedTerm": fact.namedTerm, "term": fact.term, "front": c.front, "back": c.back,
                                 "supportingQuote": c.supportingQuote, "flags": flags, "accepted": acc, "droppedDuplicateFront": dropped, "review": acc && !isClean(flags), "regenerated": regen, "firstFlags": first,
                                 "timingsMs": logs.map { ["call": $0.name, "ms": $0.ms] }, "tokens": logs.map { ["call": $0.name, "in": $0.tin, "out": $0.tout] },
                                 "totalMs": logs.reduce(0) { $0 + $1.ms }]))
          say("flash \(secId) card \(st.cards) named=\(fact.namedTerm) flags=\(flags)")
        }
        say("flash \(secId) done, section ms \(st.secMs[secId] ?? 0)")
      }
      st.wallMs = Int(Date().timeIntervalSince(t0) * 1000); report["flash"] = st
    }

    // ---------------- 7c map-reduce summaries: combine sees the section excerpts, grounded bullets ----------------
    var sumSt = Stats(); var sumBullets = 0, sumBulletsLow = 0, sumDup = 0, sumAdded = 0, sumRefIssues = 0
    var sumDroppedUnsupported = 0, sumEitherOder = 0, sumDebrisStripped = 0, sumFormulaDropped = 0
    var sumCoverage: [String] = []
    if modes.contains("sum") {
      let path = "\(out)/summaries.jsonl"; try? "".write(toFile: path, atomically: true, encoding: .utf8)
      let t0 = Date()
      // facts' quotes per section: the excerpts the combine step must be able to support every bullet with
      var quotesBySec: [String: [String]] = [:]
      for fc in fcs { quotesBySec[fc.sec.article + "-" + fc.sec.no, default: []].append(fc.fact.quote) }
      for article in Array(Set(secs.map { $0.article })).sorted() {
        var flat: [(sec: String, text: String)] = []
        var mapMs = 0
        var excerpts: [String] = []
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
          let qs = quotesBySec[secId] ?? []
          var ex = ""
          if !qs.isEmpty { ex = "\n\nExcerpts of this section (verbatim sentences of the text):\n" + qs.prefix(8).map { "• " + $0 }.joined(separator: "\n") }
          excerpts.append("[§\(sp.no) \(sp.heading)]\nBullets:\n" + bl.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n") + ex)
          appendLine(path, line(["stage": "map", "article": article, "section": sp.no, "sectionRef": "§\(sp.no)", "history": sp.history, "bullets": bl.map { $0 + " (§\(sp.no))" }, "lowOverlapBullets": low,
                                 "ms": r.ms, "tokens": ["in": r.tokensIn, "out": r.tokensOut], "error": r.error ?? NSNull()]))
          say("sum map \(secId) \(bl.count) bullets \(r.ms) ms")
        }
        let numbered = flat.enumerated().map { "\($0.offset + 1). [§\($0.element.sec)] \($0.element.text)" }.joined(separator: "\n")
        let insC = "You combine section summaries into one article summary in \(lang), from the given bullets and excerpts only. Six to ten bullets. Merge bullets that say the same thing into one; never repeat a statement. NEVER merge two statements with 'entweder … oder' when both hold (e.g. air descends dry-adiabatically AND ascends moist-adiabatically, in sequence). Every bullet must be supported word-for-word by an excerpt of the section it cites: keep the technical terms and numbers of the excerpt, do not generalise a special case. Write no bullet numbers or references like (1, 3, 4) into the text. Do not copy formula debris. Give for every bullet the numbers of the input bullets it is based on."
        let r = await call(Combined.self, instructions: insC, prompt: "Article \(article). Numbered section bullets:\n\n\(numbered)\n\nSection excerpts (verbatim sentences the statements come from):\n\n" + excerpts.joined(separator: "\n\n") + "\n\nCombine them into 6 to 10 summary bullets for the whole article, in \(lang). Merge bullets that say the same thing. Cover every part of the article. For every bullet give the source bullet numbers.")
        sumSt.add(CallLog(name: "combine", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: article + "-combine")
        struct Item { var text: String; var secs: Set<String>; var added: Bool; var droppedWhy: String }
        // quotes per section for the support check (facts' quotes + map bullet words are not enough: only verbatim excerpts)
        var secQuotes: [String: String] = [:]
        for sp in secs where sp.article == article { secQuotes[sp.no] = norm(sp.text) }
        var items: [Item] = []; var bad = 0, droppedSup = 0, eitherOder = 0, debris = 0, formulaDrop = 0
        if let v = r.value {
          for it in v.items {
            let srcs = Set(it.sources.filter { $0 >= 1 && $0 <= flat.count }.map { flat[$0 - 1].sec })
            if srcs.isEmpty { bad += 1 }
            let (txt, ch) = stripDebris(it.text)   // "(1, 3, 4)" stripped; formula-debris bullets dropped entirely
            if ch { debris += 1 }
            if txt.isEmpty { formulaDrop += 1; continue }
            if has(rx(#"\bentweder\b[\s\S]*\bor\b"#), txt) || (has(rx(#"\bentweder\b"#), txt) && has(rx(#"\border\b"#), txt)) { eitherOder += 1; droppedSup += 1; items.append(Item(text: txt, secs: srcs, added: false, droppedWhy: "eitherOder")); continue }
            // support check: >=2 content words shared with one verbatim sentence of a cited section's text
            let supported = srcs.contains { s in
              guard let body = secQuotes[s] else { return false }
              for sent in splitSentences(body) where shared(txt, sent) >= 2 { return true }
              return false
            }
            if !supported { droppedSup += 1; items.append(Item(text: txt, secs: srcs, added: false, droppedWhy: "unsupported")); continue }
            items.append(Item(text: txt, secs: srcs, added: false, droppedWhy: ""))
          }
        } else { sumSt.errors += 1 }
        let keptItems = items.filter { $0.droppedWhy.isEmpty }
        // near-duplicate bullets merged in code (later one dropped, its sources joined into the earlier)
        var dedup: [Item] = []; var dups = 0
        for it in items where it.droppedWhy.isEmpty {
          if let k = dedup.firstIndex(where: { overlapFrac($0.text, it.text) >= 0.6 }) { dedup[k].secs.formUnion(it.secs); dups += 1 } else { dedup.append(it) }
        }
        // every dropped bullet and every uncited non-history section falls back to that section's map bullet
        var added = 0
        for it in items where !it.droppedWhy.isEmpty {
          guard let s = it.secs.sorted().first, let f = flat.first(where: { $0.sec == s }) else { continue }
          if dedup.contains(where: { overlapFrac($0.text, f.text) >= 0.6 }) { dedup.firstIndex(where: { overlapFrac($0.text, f.text) >= 0.6 }).map { dedup[$0].secs.formUnion(it.secs) }; continue }
          dedup.append(Item(text: f.text, secs: [s], added: true, droppedWhy: "")); added += 1
        }
        for sp in secs where sp.article == article && !sp.history {
          if !dedup.contains(where: { $0.secs.contains(sp.no) }), let f = flat.first(where: { $0.sec == sp.no }) {
            dedup.append(Item(text: f.text, secs: [sp.no], added: true, droppedWhy: "")); added += 1
          }
        }
        sumDup += dups; sumAdded += added; sumRefIssues += bad; sumDroppedUnsupported += droppedSup; sumEitherOder += eitherOder; sumDebrisStripped += debris; sumFormulaDropped += formulaDrop
        let outB = dedup.map { $0.text + ($0.secs.isEmpty ? "" : " (" + $0.secs.sorted().map { "§\($0)" }.joined(separator: ", ") + ")") }
        let cited = Set(dedup.flatMap { $0.secs })
        let nonHist = secs.filter { $0.article == article && !$0.history }.map { $0.no }
        let rawCount = r.value?.items.count ?? 0
        sumCoverage.append("\(article): non-history sections cited \(nonHist.filter { cited.contains($0) }.count)/\(nonHist.count); all sections cited \(secs.filter { $0.article == article && cited.contains($0.no) }.count)/\(secs.filter { $0.article == article }.count); combine bullets \(rawCount) -> kept \(keptItems.count) - dedup \(dups) + fallbacks \(added) = \(dedup.count); dropped: unsupported \(droppedSup), eitherOder \(eitherOder), formula \(formulaDrop); source numbers stripped in \(debris) bullets")
        appendLine(path, line(["stage": "combine", "article": article, "bullets": outB, "bulletCount": outB.count, "combinedRaw": rawCount, "keptAfterSupport": keptItems.count, "duplicatesMerged": dups, "addedForCoverage": added,
                               "droppedUnsupported": droppedSup, "droppedEitherOder": eitherOder, "formulaDropped": formulaDrop, "sourceNumbersStripped": debris,
                               "droppedBullets": items.filter { !$0.droppedWhy.isEmpty }.map { ["text": $0.text, "why": $0.droppedWhy] },
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
      covMd += "### 7a flashcards (accepted), coverage per paragraph\n\n" + m + "\n"; covJson["flash"] = j
      let (m2, j2) = coverage(fcs.map { ($0.sec.article, $0.sec.no, $0.fact.para) }, label: "all generated flashcards")
      covJson["flashAllGenerated"] = j2; _ = m2
    }
    // run 6 comparison: paragraph coverage of its accepted flashcards (para tags were stored per card)
    var r6Cov = ""
    if !run6.isEmpty, let txt = try? String(contentsOfFile: run6 + "/flashcards.jsonl", encoding: .utf8) {
      var keys: [(String, String, Int)] = []
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any], (o["accepted"] as? Bool) == true,
              let ar = o["article"] as? String, let se = o["section"] as? String, let p = o["para"] as? String, let n = Int(p.replacingOccurrences(of: "¶", with: "")) else { continue }
        keys.append((ar, se, n))
      }
      let (m, j) = coverage(keys, label: "run 6 accepted flashcards")
      r6Cov = "### run 6 flashcards (accepted), same measure\n\n" + m + "\n"; covJson["run6flash"] = j
    }
    if let d = try? JSONSerialization.data(withJSONObject: covJson, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/coverage.json")) }

    // named-term report: which terms became cards
    var termMd = ""
    if let txt = try? String(contentsOfFile: "\(out)/named-terms.jsonl", encoding: .utf8) {
      var lines: [(ar: String, se: String, para: String, term: String, became: Bool)] = []
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
              let ar = o["article"] as? String, let se = o["section"] as? String, let term = o["term"] as? String,
              let para = o["para"] as? String, let became = o["becameCard"] as? Bool else { continue }
        lines.append((ar, se, para, term, became))
      }
      var seenTerms = Set<String>(); var uniq = 0
      for l in lines where l.became && !seenTerms.contains("\(l.ar)-\(l.term.lowercased())") { seenTerms.insert("\(l.ar)-\(l.term.lowercased())"); uniq += 1 }
      let rows = lines.map { "| \($0.ar)-\($0.se) | \($0.para) | \($0.term) | \($0.became ? "yes" : "no (same sentence already a card)") |" }.joined(separator: "\n")
      termMd = "\n## named-term hits (rule 1): terms that became facts/cards\n\n| section | para | term | own card |\n|---|---|---|---|\n" + rows + "\n- hits: \(lines.count), became a fact outside the cap: \(uniq)\n"
    }

    // ---------------- summary ----------------
    func block(_ name: String, _ s: Stats) -> String {
      let rates = s.flagCount.sorted { $0.key < $1.key }.map { "  - \($0.key): \(pct($0.value, s.cards))" }.joined(separator: "\n")
      let reg = s.regenReason.filter { !$0.key.hasPrefix("_") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
      let calls = s.perCall.sorted { $0.key < $1.key }.map { "\($0.key) \(median($0.value)) (n=\($0.value.count))" }.joined(separator: ", ")
      let secMsAll = s.secMs.values.map { $0 }
      let tpa = s.accepted == 0 ? "n/a" : "\((s.tokIn + s.tokOut) / s.accepted) (in \(s.tokIn / s.accepted), out \(s.tokOut / s.accepted))"
      return """
      ## \(name)

      - facts: \(s.facts) (quote not verbatim: \(s.factQuoteBad), rejected by code: \(s.factsRejected)); cards: \(s.cards); accepted (no hard flag): \(pct(s.accepted, s.cards)), of which review (soft flag): \(s.review); dropped for a duplicate front: \(s.droppedDupFront); call errors: \(s.errors)
      - flag rates (share of cards; a card can carry several):
      \(rates.isEmpty ? "  - none" : rates)
      - regenerated: \(s.regenerated), regeneration failed: \(s.regenFailed); first-attempt defects by reason: \(reg.isEmpty ? "none" : reg)
      - median ms per call: \(calls)
      - ms per section: mean \(secMsAll.isEmpty ? 0 : secMsAll.reduce(0, +) / secMsAll.count), median \(median(secMsAll)), total wall \(s.wallMs) ms (per-section list in timing-sections.json)
      - tokens (in/out): \(s.tokIn)/\(s.tokOut); per accepted card (in+out): \(tpa)
      - ms per accepted card: \(s.accepted == 0 ? "n/a" : "\(s.secMs.values.reduce(0, +) / s.accepted)")
      """
    }
    var md = "# pipeline summary (run 7, \(lang))\n\n- input: \(input) (\(secs.count) sections: \(Set(secs.map { $0.article }).sorted().joined(separator: ", "))); modes: \(modes.joined(separator: ",")); MCQ not run (opt-in)\n\n"
    if let s = report["flash"] { md += block("7a flashcards", s) + "\n" + termMd + "\n" }
    md += "## coverage per paragraph (cards from the paragraph / paragraphs over 60 words)\n\n" + covMd + r6Cov
    if report["sum"] != nil {
      let s = sumSt
      md += "## 7c summaries (map-reduce + support check + fallbacks)\n\n- map calls: \(s.perCall["mapSummary"]?.count ?? 0), median ms \(median(s.perCall["mapSummary"] ?? [])); combine calls: \(s.perCall["combine"]?.count ?? 0), median ms \(median(s.perCall["combine"] ?? []))\n- section bullets: \(sumBullets), with >50% content words missing from the section: \(sumBulletsLow)\n- combine bullets dropped as unsupported (<2 content words with a quote of the cited section): \(sumDroppedUnsupported); 'entweder/oder' merges rejected: \(sumEitherOder); formula-debris bullets dropped: \(sumFormulaDropped); source numbers \"(1, 3, 4)\" stripped in: \(sumDebrisStripped)\n- near-duplicate combined bullets merged in code: \(sumDup); fallback map bullets added (dropped bullet or uncited non-history section): \(sumAdded); combined bullets without a valid source: \(sumRefIssues)\n- " + sumCoverage.joined(separator: "\n- ") + "\n- tokens (in/out): \(s.tokIn)/\(s.tokOut); total wall \(s.wallMs) ms; call errors \(s.errors)\n- ms per section (map): " + s.secMs.filter { !$0.key.hasSuffix("combine") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ") + "\n\n"
    }
    var timing: [String: Any] = [:]
    for (k, s) in report { timing[k] = s.secMs.mapValues { $0 }.merging(s.secTok.reduce(into: [String: Int]()) { $0[$1.key + ".tokIn"] = $1.value.0; $0[$1.key + ".tokOut"] = $1.value.1 }) { a, _ in a } }
    if let d = try? JSONSerialization.data(withJSONObject: timing, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/timing-sections.json")) }
    try? md.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    say(md)
  }
}
