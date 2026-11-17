// Probe run 10 (German): flashcards + summaries only. Builds on run 9 (merged main). Changes vs run 9 (Glidr's run-9 score):
// A duplicate fronts: a clash needs Jaccard >= 0.7 on front content-word stems AND >= 0.5 overlap of the two facts'
//   statements (run 9's min-normalised >=0.85 dropped 23 cards, only 3 real dupes); the clash hint names the clashing
//   front ("already asked: <front>; ask about a different detail of the quote"); a second clash drops the card.
//   FACTS are deduped before card generation too (same canonical quote span or >=0.7 statement overlap -> keep one).
// B named terms: "sog." cue fixed for the ∯-protected form ("dem sog. Rückseitenwetter" was never matched); the
//   "wird … genannt" cue tightened so it captures the noun before "genannt" (Totluft, not "Luft"); a parenthesis that
//   renames a noun phrase accepts its INNER term when the inner is a technical compound (-krankheit/-fenster/…), so
//   Föhnkrankheit (¶5) fires; extractAfter takes an adjective + capitalised noun ("pulsierender Thermik") but not a
//   run with prepositions inside; junk filter: empty, pure numbers/years, single generic words (Luft, Föhn, Wind, …),
//   verb-form tails, dotted place names. termsLost keep-regeneration quotes the lost tokens verbatim.
// C fronts: explicit Wie/Wann/Wo/Wozu/Warum instruction with examples in base + card prompt; back self-repeat dedup
//   lowered to 50% content-word overlap.
// D summaries: per bullet a support check against its own section (named-term/number tokens, not generic words) and a
//   causal-connector rule (durch/da/weil/wodurch/deshalb must sit in the cited sentence); combine quota >= 1 bullet per
//   non-history section, always keep bullets carrying a named term or a number+unit; combine logs its raw output and a
//   per-pick validation reason (run 9's Föhn combine gave 6 picks, all invalid: sources parsed to != 1 index).
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-r10.swift -o $TMPDIR/pipeline-probe-r10
// Run:   $TMPDIR/pipeline-probe-r10 <dir of sections> <out dir> German [flash,sum] [older run dirs for the comparison table]
// 9a fact picker = run 6's proportional allocation (~1 fact per 80 words, <=2 per paragraph, >=1 for every paragraph
//   over 60 words — the factsPara top-up is kept) PLUS named-term sentences as extra mandatory facts (run 7 rule),
//   with run 8's abbreviation protection and junk filters, but a LOOSER term acceptance (run 8 caught only 2 terms):
//   accept a capture if it is a capitalised noun/compound or an abbreviation >=4 chars that is not a pronoun/adverb,
//   not a bare sentence-initial function word, not a generic noun ("Stelle", "Art", …), not a verb form and not a
//   place name ("in X" of the text). Fixes vs run 8: nearest-capitalised-word extraction across a short lowercase gap
//   ("von Blauthermik – der Himmel", "Totluft genannt"); an indicator term may head its own sentence ("Cumuluswolken
//   sind ein sichtbares Anzeichen für …"); "sogenannte X" trims its function-word tail; junk stays out ("Heute",
//   "das", place names, clause captures).
// 9b flashcards: frontContainsAnswer fires ONLY when >=80% of the back's DISTINGUISHING words (back content words
//   minus the section heading and minus the question-word list) appear in the front — run 8's flat >=60%-of-all-back-words
//   rule fired on 58% because a question and its answer share topic words. termsLost as in run 8 (restricted token set:
//   capitalised non-initial nouns, numbers with units, the named term) with one "keep" regeneration; front uniqueness,
//   question words and truncation checks as in run 8. Verbatim quote check gains tag-stripping, dash/quote/dot
//   normalisation and an in-order content-word fallback (>=90% of the quote's >=4-letter words appear in order) —
//   run 8 flagged 17 quotes, most of them copy-level noise.
// 9c summaries: run 8's verbatim combine unchanged (select + order map bullets, each keeps its own §id, code dedup).
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-r9.swift -o $TMPDIR/pipeline-probe-r9
// Run:   $TMPDIR/pipeline-probe-r9 <dir of sections> <out dir> German [flash,sum] [older run dirs for the comparison table]
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
  @Guide(description: "front of the flashcard: a question in German that starts with or contains a W-question word (Was, Wie, Wann, Wo, Warum, Wodurch, Womit, Wozu, Welcher/Welche/Welches, Welche Rolle, In welcher Weise) and names its subject explicitly; never a bare term; use 'Wie/Wann/Wo/Wozu/Warum' when the answer is not a thing ('Wie verhält sich die Atmosphäre wie?', 'Wann spricht man vom Föhnsturm?', 'Wozu benötigt die Thermik Warmluft?')") var front: String
  @Guide(description: "back of the flashcard: a short, precise answer of one or two sentences, from the text, no sentence repeated, all technical terms and numbers with units of the supporting quote present in the answer") var back: String
  @Guide(description: "quote verbatim from the text: one exact contiguous passage copied character for character that supports the back") var supportingQuote: String
}
@Generable struct SectionBullets: Codable {
  @Guide(description: "two or three short summary bullets of the section, one sentence each", .minimumCount(2), .maximumCount(3)) var bullets: [String]
}
@Generable struct CombinedItem: Codable {
  @Guide(description: "ignored placeholder (the code keeps the chosen input bullet verbatim): repeat the input bullet text unchanged") var text: String
  @Guide(description: "exactly one number: the number of the input bullet this output bullet is (its text is kept word for word)", .count(1)) var sources: [Int]
}
@Generable struct Combined: Codable {
  @Guide(description: "six to ten chosen input bullets covering the whole article without repeating each other, in a sensible order", .minimumCount(6), .maximumCount(10)) var items: [CombinedItem]
}
/// run 10 combine diagnostics: raw source list + validation reason of every pick, and the raw model output
struct PickLog { var raw: String; var ok: Bool; var why: String }

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

// ---- run 8 ----
/// abbreviations whose period must not end a sentence (protected with ∯ before splitting and matching)
let abbrList = ["sog.", "z. B.", "z.B.", "u. U.", "u.U.", "u. a.", "bzw.", "ca.", "d. h.", "d. h.", "vs.", "usw.", "etc.", "vgl.", "engl.", "ff.", "u. s. w.", "etc."]
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
      for d in abbrList { body = body.replacingOccurrences(of: d, with: d.replacingOccurrences(of: ".", with: "∯")) }
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
/// canonical form for the verbatim check: German quote marks and dashes unified, dots normalised, whitespace collapsed
func canonV(_ s: String) -> String {
  norm(s).replacingOccurrences(of: "„", with: "\"").replacingOccurrences(of: "“", with: "\"")
    .replacingOccurrences(of: "«", with: "\"").replacingOccurrences(of: "»", with: "\"")
    .replacingOccurrences(of: "–", with: "-").replacingOccurrences(of: "—", with: "-")
    .replacingOccurrences(of: "’", with: "'")
}
/// content words (>=4 letters, lowercased) in order — the fallback verbatim test tolerates copy-level noise
func contentWords(_ s: String) -> [String] { words(canonV(s)) }
/// quote is verbatim if its canonical form occurs in the canonical section text, or >=90% of its content words
/// appear IN ORDER there (tolerates a model that retyped "fliegt" for "fließt", dropped a bracketed aside, …)
func quoteVerbatim(_ q: String, _ secText: String) -> Bool {
  let cq = canonV(q), cs = canonV(secText)
  if cq.isEmpty { return false }
  if cs.contains(cq) { return true }
  let qw = contentWords(q); guard qw.count >= 6 else { return false }
  let sw = contentWords(secText)
  var i = 0, matched = 0
  for w in qw { while i < sw.count && sw[i] != w { i += 1 }; if i < sw.count { matched += 1; i += 1 } }
  return Double(matched) / Double(qw.count) >= 0.9
}
func shared(_ a: String, _ b: String) -> Int { stems(a).intersection(stems(b)).count }
/// run 10 duplicate-front rule: Jaccard on the front content-word stems (min-normalised overlap made "Was ist
/// Thermik?" clash with every Thermik front); paired in code with a fact/back overlap check
func jaccard(_ a: String, _ b: String) -> Double {
  let wa = stems(a), wb = stems(b); let u = wa.union(wb).count
  return u == 0 ? 0 : Double(wa.intersection(wb).count) / Double(u)
}
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
func rxc(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
/// share of the BACK content words (stemmed) that also occur in the front; needs >=4 back words
func backCoveredByFront(_ f: String, _ b: String) -> Double { let sb = stems(b); return sb.count < 4 ? 0 : Double(sb.intersection(stems(f)).count) / Double(sb.count) }
let hedgeRe = rx(#"\b(ebenfalls|auch|andere[nrsm]?|nicht direkt|nur in bestimmten|teilweise)\b"#)
let negRe = rx(#"\b(nicht|kein\w*|nie|niemals|ohne|weder|statt|anstatt|sondern|gegenteil|gegensatz|unabhängig)\b"#)
let demoRe = rx(#"\b(diese[rnms]?|solche[rnms]?|dies|dieses|daher|deshalb|dadurch)\b"#)
func has(_ r: NSRegularExpression, _ s: String) -> Bool { r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
let recapRe = rx(#"^(zusammenfassung|merke|fazit|siehe|abbildung|tabelle)\b"#)
func isHistory(_ h: String) -> Bool { has(rx(#"theorie|geschichte|gap dynamic|hydrologisch"#), h) }

/// duplicate sentences of a back removed in code, exact and by >=50% content-word overlap with an earlier sentence
/// (run 10: run 9's 70% missed German paraphrases like "Das Vinschgau ist das trockenste Tal … / … um das trockenste Tal")
func dedupSentences(_ s: String) -> (String, Bool) {
  let parts = splitSentences(norm(s))
  var kept: [String] = []; var dropped = false
  for p in parts {
    let k = p.lowercased().trimmingCharacters(in: .punctuationCharacters)
    if k.isEmpty { continue }
    if kept.contains(where: { contentOverlap($0, p) >= 0.5 }) { dropped = true; continue }
    kept.append(p)
  }
  return (kept.joined(separator: " "), dropped || kept.count != parts.count)
}

// ---- run 8 rules: precise named terms, indicator/condition cues, term survival, question fronts ----
/// abbreviation dots are ∯-protected before matching too, so "sog." no longer breaks the "wird … genannt" zone or a sentence
func abbrProtect(_ s: String) -> String { var r = s; for d in abbrList { r = r.replacingOccurrences(of: d, with: d.replacingOccurrences(of: ".", with: "∯")) }; return r }
// run 10: "sog." matches its ∯-protected form too (run 9's "sog\." never fired on protected text, so ¶20
// "dem sog. Rückseitenwetter" was missed); the "wird … genannt" zone allows only lower-case words (no verbs, no
// prepositions), so it captures the noun before "genannt" ("Totluft") and not a clause or "Luft"
let namedTermRe = rx(#"(spricht man von|sogenannte[rns]?|sog[∯.]|nennt man|(?:so |es )?heißt(?:en)?\b|bezeichnet (?:man|er) (als|zu)|(?:wird|werden)\s(?:[a-zäöüß]+\s){1,4}[A-ZÄÖÜ][\wäöüß-]+\s+genannt)"#)
/// "X sind (ein sichtbares) Anzeichen/Merkmal/Zeichen für Y" — indicator cue; the term is X (before the cue), Y is kept in the sentence
let anzeichenRe = rx(#"\b(?:sind|ist|sei|waren)\b[^∯.]{0,40}?(?:ein[e]?)?\s*(?:sichtbares?|deutliches?|typisches?|unmittelbares?|wichtiges?)?\s*(Anzeichen|Anzeichen für|Merkmal[e]?|Kennzeichen|Zeichen|Hinweis[e]?)\s*(?:für|darauf)?"#)
/// condition cue: "überall dort, wo …", "wenn … trifft/auftrifft" — a condition statement, mandatory at the cap
let condWhereRe = rx(#"überall dort,\s*wo\b|\bwenn\b[^∯.]{0,80}?(?:trifft|auftrifft|traf|auftraf)"#)
/// words that may start a parenthesis only when the parenthesis is a term, never a clause or place note
let parenLeadBad = ["bei","aus","zur","zum","in","im","am","an","auf","von","mit","ohne","vor","nach","über","unter","abhängig","möglich","etwa","circa","wie","bzw","oder","und","aber","nur","auch","selbst","falls","wenn","siehe"]
/// pronouns, adverbs and function words that are never a term even when capitalised
let notTermLower: Set<String> = ["das","dies","dieses","diese","dieser","dasselbe","jenes","solche","solcher","man","etwas","nichts","alles","vieles","weniges","beides","hier","dort","dann","daher","deshalb","dadurch","danach","dabei","davon","daraus","worin","wobei","warum","weshalb","wodurch","womit","wann","wie","was","wer","welche","welcher","welches","ob","als","sowie"]
/// words that are never a named term (past participles and verbs caught by loose pattern matches)
let notTerm: Set<String> = ["abgekühlt","abgeregnet","abgetragen","abgelöst","angegeben","beschrieben","bezeichnet","benannt","entdeckt","eingemischt","erwärmt","geändert","genutzt","gemessen","gestört","getragen","gebracht","geworden","gezeigt","geführt","gehalten","haben","hat","kommt","ermöglicht","erreicht","entsteht","entstanden","gebildet","bildet","verursacht","verändert","verbessert","verbreitet","verschiebung","unsichtbar","abgegeben","aufgetreten","ausgebildet","existiert","gewählt","worden"]
/// capitalised word run (a noun phrase): a capitalised head plus following lower-case words; abbreviations count as one token
let capRunRe = rxc(#"[A-ZÄÖÜ][\wäöüß-]*(?:\.[A-Z]\.)*(?:\s+[a-zäöüß][\wäöüß-]+){0,3}"#)
/// an abbreviation term: 2-6 letters with dots (Ac lent, u. U., Föhn i. A.) — accepted as a term form
let abbrevTermRe = rxc(#"\b[A-Z]{2,6}(?:\.[A-Za-z]?\.?)+\s*[a-zäöüß]*"#)
/// quoted terms count too: „X" or "X"
let quotedTermRe = rxc(#"(?:„|")[A-ZÄÖÜ][^"“”]{3,40}(?:“|")"#)
/// the term is the last capitalised run in the zone (up to the first comma/semicolon/colon or sentence end)
func extractTerm(_ s: String, upTo endIdx: Int) -> String {
  let chars = Array(s)
  let rest = String(chars[0..<min(endIdx, chars.count)])
  let cut = rest.lastIndex(where: { ",;:".contains($0) })
  let zone = cut.map { String(rest[rest.index(after: $0)...]) } ?? rest
  let caps = capRunRe.matches(in: zone, range: NSRange(zone.startIndex..., in: zone)).compactMap { Range($0.range, in: zone).map { String(zone[$0]) } }
  return caps.last ?? ""
}
/// the noun phrase directly BEFORE a position (last capitalised run before it, cut at comma/semicolon/colon)
func extractBefore(_ s: String, before lower: String.Index) -> String {
  let zone = String(s[s.startIndex..<lower])
  let cut = zone.lastIndex(where: { ",;:".contains($0) })
  let z = cut.map { String(zone[zone.index(after: $0)...]) } ?? zone
  let caps = capRunRe.matches(in: z, range: NSRange(z.startIndex..., in: z)).compactMap { Range($0.range, in: z).map { String(z[$0]) } }
  return caps.last ?? ""
}
/// run 10: an inflected adjective directly before a capitalised noun IS part of the term ("pulsierender Thermik",
/// "indifferente Schichtung"); prepositions inside still disqualify (handled by trimTermTail / looksLikeTerm)
let adjCapPairRe = rxc(#"^[a-zäöüß]+(?:en|em|er|es|e)\s+[A-ZÄÖÜ][\wäöüß-]+$"#)
/// the noun phrase directly AFTER a position: the next capitalised word plus at most two following lower-case words;
/// run 10 also takes an adjective + capitalised noun pair ("pulsierender Thermik"); a longer participle run
/// ("schießend strömende Luft") stays out here — parenthesis/other cues catch those
func extractAfter(_ s: String, after upper: String.Index) -> String {
  let zone = String(s[upper...])
  guard let m = capRunRe.firstMatch(in: zone, range: NSRange(zone.startIndex..., in: zone)), let r = Range(m.range, in: zone) else { return "" }
  var t = norm(String(zone[r]))
  if let c = t.firstIndex(where: { $0 == "," || $0 == ";" }) { t = String(t[t.startIndex..<c]) }
  let ws = t.split(separator: " ")
  guard let h = ws.first else { return "" }
  let headClean = h.allSatisfy { $0.isUppercase || $0 == "-" || $0 == "." }
  if !headClean && !(ws.count == 2 && has(adjCapPairRe, t)) { return "" }   // adjective/participle start: not a term here
  return ws.count > 3 ? ws.prefix(3).joined(separator: " ") : t
}
/// run 10: a parenthesis whose INNER term is a technical compound ("(Föhnkrankheit)", "(labile Schichtung)") counts
/// even when the noun phrase before it is a generic word — run 9 rejected ¶5 because "Beschwerden" failed okTerm
let techSuffixRe = rxc(#"(?:krankheit|fenster|mauer|sturm|wolken|wolke|thermik|regen|luft|front|schichtung|druckgradient|druck)$"#)
/// generic nouns that name nothing specific: never a term even when capitalised (run 8 caught "Stelle")
let genericNouns: Set<String> = ["stelle","zeit","fall","art","weise","form","teil","bereich","ende","anfang","grund",
  "gedanke","rolle","bedeutung","ursache","wirkung","funktion","eigenschaft","seite","rand","fläche","masse","zustand","vorgang","beispiel",
  // run 10 (Glidr's score): the article's own topic words and bare physical nouns name nothing specific either
  "luft","wind","wetter","atmosphäre","temperatur","energie","höhe","boden","gebiet","berg","gebirge","tal","lage","wert","grad","rate","gradiente"]
/// run 10 junk filter: an empty capture, a pure number/year or a bare generic word is never a named term
let yearRe = rxc(#"^(?:1[5-9]\d\d|20[0-2]\d)$"#)
func junkTerm(_ t: String) -> (Bool, String)? {
  let tt = norm(t).trimmingCharacters(in: CharacterSet(charactersIn: " „\"'‘’·.")).trimmingCharacters(in: .whitespaces)
  if tt.isEmpty { return (true, "empty") }
  // a capture that is ONLY digits/decimal separators is junk; the first candidate of a cue may still be a number
  // ("zum sogenannten Steigungsregen" — the zone's last cap run is "(333,5 kJ/kg)" whose head token is numeric),
  // and pick() then tries the next candidate
  if tt.allSatisfy({ $0.isNumber || $0 == "," || $0 == "." }) { return (true, "number") }
  let h = String(tt.split(separator: " ").first ?? "").lowercased()
  // a bare single generic word is junk; a multi-word capture whose HEAD is generic may still be a term
  // ("schießend strömende Luft" — run 7's rotor hit — must survive looksLikeTerm, which owns the final check)
  if tt.split(separator: " ").count == 1 && genericNouns.contains(h) { return (true, "generic-word") }
  if has(yearRe, tt) { return (true, "year") }
  return nil
}
/// prepositions/conjunctions that may not sit inside the gap between a term and its cue
let prepLower: Set<String> = ["bei","nach","aus","von","zu","zur","zum","im","am","an","auf","für","mit","ohne","um",
  "durch","gegen","über","unter","vor","hinter","zwischen","innerhalb","außerhalb","wegen","trotz"]
/// trim a candidate: drop trailing function words and finite-verb tails ("Ablösung tritt ein" -> "Ablösung")
func trimTermTail(_ t: String) -> String {
  var ws = t.split(separator: " ").map(String.init)
  while ws.count > 1 && (stopLower.contains(ws[ws.count - 1].lowercased()) || notTermLower.contains(ws[ws.count - 1].lowercased())) { ws.removeLast() }
  // run 10: a preposition inside a short capture means it is a phrase, not a term ("Wind aus Osten" -> "Osten", which
  // the junk filter then rejects; "Ballonhülle zur Umgebung" -> "Umgebung")
  if ws.count >= 3, let p = ws.firstIndex(where: { prepLower.contains($0.lowercased()) }), p > 0, p < ws.count - 1 { ws = [ws[ws.count - 1]] }
  if ws.count >= 2, ["ein","statt","ab"].contains(ws[ws.count - 1].lowercased()),
     has(rx("^(tritt|finde|fände|gelte|mache|habe|sei|werde|komme)$"), ws[ws.count - 2].lowercased()) { ws.removeLast(); ws.removeLast() }
  return ws.joined(separator: " ")
}
/// run 9 acceptance: a capitalised noun/compound or abbreviation >=4 chars, not pronoun/adverb, not a bare
/// sentence-initial word (unless the cue heads the sentence and introduces the term), not a generic noun, not a
/// verb form, not a place name. Returns (ok, reason, trimmed term).
func looksLikeTerm(_ raw: String, sentInitials: Set<String> = [], places: Set<String> = [], initialOk: Bool = false) -> (Bool, String, String) {
  let t0 = norm(raw).trimmingCharacters(in: CharacterSet(charactersIn: " „\"'“”‘’·.")).trimmingCharacters(in: .whitespaces)
  if let j = junkTerm(t0) { return (false, j.1, t0) }   // run 10: empty / number / year / bare generic word
  if t0.count < 4 { return (false, "short", t0) }
  let ws0 = t0.split(separator: " ").map(String.init)
  let hh = String(ws0[0].prefix(while: { $0 != "." })).lowercased()
  if has(quotedTermRe, t0) { return (true, "ok", t0) }
  if notTermLower.contains(hh) || notTerm.contains(hh) { return (false, "pronoun/verb-list", t0) }
  if places.contains(t0.lowercased()) || places.contains(hh) { return (false, "place", t0) }
  if has(verbRe, hh) { return (false, "verb", t0) }
  if genericNouns.contains(hh) { return (false, "generic-noun", t0) }
  let t = trimTermTail(t0)
  if t.count < 4 { return (false, "short", t) }
  let h = String(t.split(separator: " ").first ?? "")
  // a single word that opens its own sentence is usually the topic, not the named term — unless the cue heads the
  // sentence too ("Cumuluswolken sind ein sichtbares Anzeichen für …" introduces the term itself)
  if !t.contains(" "), sentInitials.contains(h), !initialOk { return (false, "sent-initial", t) }
  if !t.contains(" "), sentenceStartCaps.contains(h), !initialOk { return (false, "startcap-word", t) }
  return (true, "ok", t)
}
/// the capitalised word nearest the END of a zone, crossing at most three short lowercase words that contain no
/// preposition/pronoun ("… auch Totluft " -> "Totluft"); "" if none qualifies
func nearestCapBefore(_ zone: String) -> String {
  let p = try! NSRegularExpression(pattern: #"([A-ZÄÖÜ][\wäöüß-]{2,})(?:\s+(?:[a-zäöüß]+\s+){0,3})$"#)
  guard let m = p.firstMatch(in: zone, range: NSRange(zone.startIndex..., in: zone)), let g = Range(m.range(at: 1), in: zone) else { return "" }
  return norm(String(zone[g]))
}
/// "spricht man von X" / "nennt man X": the first capitalised word following von/als within 80 chars after the cue
func capAfterPrep(_ s: String, from idx: String.Index) -> String {
  let win = String(s[idx...].prefix(80))
  guard let m = rx(#"(?:von|als)\s+([A-ZÄÖÜ][\wäöüß-]{2,})"#).firstMatch(in: win, range: NSRange(win.startIndex..., in: win)),
        let g = Range(m.range(at: 1), in: win) else { return "" }
  return norm(String(win[g]))
}
/// the head word of a candidate term: its first token (a dotted abbreviation like "Ac lent." heads with "Ac")
func headWord(_ t: String) -> String? {
  let toks = norm(t).split(separator: " ")
  guard let f = toks.first else { return nil }
  if f.contains("."), f.count >= 2, f.first?.isUppercase == true { return String(f.prefix(2)) }
  return String(f)
}
/// place names found in the text as "in X": never a technical term (cities, regions)
func placeNames(_ fullText: String) -> Set<String> {
  var s = Set<String>()
  for m in rxc(#"\bin\s+([A-ZÄÖÜ][\wäöüß]+(?:-[A-Za-zäöüß]+)?)"#).matches(in: fullText, range: NSRange(fullText.startIndex..., in: fullText)) {
    guard let r = Range(m.range(at: 1), in: fullText) else { continue }
    s.insert(String(fullText[r]).lowercased())
  }
  return s
}
let condRe = rx(#"\b(bei\w*|wenn|nach\w*|sobald|falls|sofern)\b"#)
let histSentRe = rx(#"(\b(1[5-9]\d\d|20[0-2]\d)\b|wurde \w+ (beschrieben|erwähnt|entdeckt|eingeführt)|\b(?:nach|von|durch) [A-ZÄÖÜ][a-zäöüß]+ (beschrieben|entdeckt|benannt)|Geschichte|Historie|erstmals)"#)
let stopLower: Set<String> = ["der","die","das","des","dem","den","ein","eine","einen","einem","einer","und","oder","aber","doch","denn","weil","wenn","als","wann","wie","wer","was","werde","werden","wurde","worden","sind","sein","ist","bist","sei","seien","war","waren","hat","hatte","hatten","habe","haben","kann","können","konnte","muss","müssen","musste","darf","soll","sollen","will","mag","bei","nach","aus","von","zu","zur","zum","im","am","an","auf","für","mit","ohne","um","durch","gegen","über","unter","vor","hinter","zwischen","in","innerhalb","außerhalb","dass","damit","dadurch","deshalb","daher","dann","auch","nur","schon","noch","bereits","etwa","circa","sehr","mehr","weniger","sowie","sowohl","bzw","etc","dh","zb","usw","andere","anderen","anderer","anderes","anderem","gleiche","gleicher","selbe","selber","solche","solcher","solches","dieser","diese","dieses","diesen","diesem","jener","jene","jenes","welcher","welche","welches","welchen","welchem","würde","würden","ließe","lässt","lassen","gab","gibt","wurden","beim","vom","ungefähr","knapp","rund","gut","viel","wenig","mehrere","alle","keine","kein","manche","folgende","folgendem","folgenden","nämlich","zwar","jedoch","allerdings","hingegen","dagegen","ebenso","ebenfalls","somit","folglich","also","spricht","sprechen","nennt","heißen","heißt","genannt","bezeichnet","bedeutet","beinhaltet","enthalten","enthält","dabei","danach","wobei","indem","indes","solange","sobald","nachdem","bevor","während","trotz","wegen","halber","zunächst","zudem","hinaus","etwa"]
let sentenceStartCaps: Set<String> = ["Der","Die","Das","Ein","Eine","Kein","Keine","Manche","Mehrere","Alle","Wenn","Nach","Weil","Auch","Dabei","Dann","Hier","Dort","Zum","Zur","Am","Im","Auf","Von","Aus","Mit","Ohne","Vor","Über","Unter","Durch","Gegen","Zwischen","Bei","Ab","Bis","Seit","Dies","Diese","Dieser","Dieses","Welche","Welcher","Folgende","Folgender","Zwar","Jedoch","Dagegen","Ebenso","Somit","Also","Nur","Schon","Noch","Bereits","Etwa","Sehr","Mehr","Weniger","Gut","Viel","Wenig","Oft","Immer","Nie","Niemals","Ist","Sind","War","Waren","Hat","Hatte","Haben","Kann","Muss","Darf","Soll","Wird","Werden","Wurde","Demnach","Heute","Hierbei","Daher","Deshalb","Damit","Dadurch","Außerdem","Zudem","Weitere","Speichert","Leitet","Beträgt","Da","Gerade","Pflanzen","Solche","Dieser"]
/// German verbs in 3rd person (always lower case mid-sentence): never a technical term
let verbRe = rx(#"^(?:ver|be|zer|ent|er|ab|an|auf|aus|bei|ein|mit|nach|vor|zu|zur|über|unter)[a-zäöüß-]{2,}(?:en|et|e|st|est)$"#)
/// technical terms of a text: capitalised nouns/compounds (>=4 letters, not sentence-initial, not a verb) and numbers with units
func techTerms(_ s: String) -> [String] {
  var out: [String] = []
  for m in rxc(#"\b[A-ZÄÖÜ][a-zäöüß]+(?:-[A-Za-zäöüß]+)*"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
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
/// formula debris: >=2 Greek letters anywhere, or "=" followed by a mix of letters and digits, or run-together operators
let formulaDebrisRe = rx(#"(?:[\p{Greek}].*){2,}|=[^\s]*[A-Za-zÄÖÜäöüß][^\s]*\d|=[^\s]*\d[^\s]*[A-Za-zÄÖÜäöüß]|[=+\-*/^≤≥<>]{2,}"#)
/// "(1, 3, 4)" / "(§3, §7)" style source-number debris
let srcNumRe = rx(#"\(\s*\d{1,2}([;,]\s*\d{1,2})+\s*\)|\(?\s*§\d+([;,]\s*§\d+)+\s*\)?"#)
func stripDebris(_ s: String) -> (String, Bool) {
  var r = norm(s); var changed = false
  let sr = srcNumRe.stringByReplacingMatches(in: r, range: NSRange(r.startIndex..., in: r), withTemplate: "")
  if sr != r { r = norm(sr); changed = true }
  if has(formulaDebrisRe, r) { return ("", true) }
  return (r.trimmingCharacters(in: .whitespacesAndNewlines), changed)
}
/// lines that are mostly formula debris (>=2 Greek letters or an "=" with a letter/digit mix, and few German words):
/// stripped in code BEFORE the map call so no formula ever reaches a summary bullet
func stripFormulaLines(_ text: String) -> (String, Int) {
  var dropped = 0
  let kept = text.components(separatedBy: "\n").filter { l in
    let t = norm(l)
    if t.isEmpty { return true }
    let g = t.unicodeScalars.filter { $0.value >= 0x0370 && $0.value <= 0x03FF }.count
    let germanWords = t.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count >= 4 && $0.first?.isLetter ?? false }.count
    let isFormula = (g >= 2 && has(rx("="), t)) || (has(rx(#"=[^\s]*[A-Za-zÄÖÜäöüß][^\s]*\d|=[^\s]*\d[^\s]*[A-Za-zÄÖÜäöüß]"#), t) && germanWords < 6)
    if isFormula { dropped += 1; return false }
    return true
  }
  return (kept.joined(separator: "\n"), dropped)
}

struct CallLog { var name: String; var ms: Int; var tin: Int; var tout: Int }
func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : "\(n)/\(d) (\(Int(Double(n) * 100 / Double(d)))%)" }
func flagKey(_ f: String) -> String { f.split(separator: ":").first.map(String.init) ?? f }
/// stem of a German content word (>=4 letters, lowercased): plural/inflection-insensitive comparison
func stems4(_ s: String) -> Set<String> { Set(words(s).map { String($0.prefix(4)) }) }
/// named-term coverage of accepted cards: the term itself or >=2 shared content-word stems with its sentence
func termCovered(_ term: String, sent: String, front: String, back: String) -> Bool {
  let t = norm(term).lowercased()
  if !t.isEmpty && (norm(front + " " + back).lowercased().contains(t) || norm(front + " " + back).lowercased().contains(String(t.prefix(4)))) { return true }
  let ts = stems4(sent)
  let fb = stems4(front + " " + back).subtracting(qWordList.map { String($0.prefix(4)) })
  return ts.count >= 2 && ts.intersection(fb).count >= 2
}

struct Stats {
  var facts = 0, factQuoteBad = 0, factsRejected = 0, cards = 0, accepted = 0, review = 0, regenerated = 0, regenFailed = 0, errors = 0, tokIn = 0, tokOut = 0, wallMs = 0, droppedDupFront = 0
  // run 10: duplicate-front counters (before/after rate) and facts removed by the pre-generation dedupe
  var frontClashes = 0, cardsCheckedForClash = 0, factsDroppedDup = 0
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

/// named-term hits of a paragraph with accept/reject reason. The sentence is matched in ∯-protected form so "sog."
/// and "z. B." neither split the sentence nor cut the match zone; positions map back 1:1 (∯ replaces "." only).
/// A term is accepted only if looksLikeTerm holds and it is not a place name ("in X" of the text) or junk.
func namedTermSentences(_ p: Para, places: Set<String>) -> [(term: String, sent: String, cue: String, accepted: Bool, reason: String)] {
  var out: [(String, String, String, Bool, String)] = []
  // sentence-initial words of this paragraph: a single-word capture that opens its own sentence is the topic, not
  // the named term (run 8's "Heute"); an indicator cue heading the sentence is the exception (Cumuluswolken)
  var initials = Set<String>()
  for sent in splitSentences(p.text) { if let m = rxc("[A-ZÄÖÜ][\\wäöüß-]*").firstMatch(in: sent, range: NSRange(sent.startIndex..., in: sent)), let rg = Range(m.range, in: sent) { initials.insert(String(sent[rg])) } }
  func okTerm(_ t: String, initialOk: Bool = false) -> (Bool, String, String) { looksLikeTerm(t, sentInitials: initials, places: places, initialOk: initialOk) }
  /// first candidate that passes acceptance; "" if none
  func pick(_ cands: [String], initialOk: Bool = false) -> String {
    for c in cands where !c.isEmpty { let (ok, _, t) = okTerm(c, initialOk: initialOk); if ok { return t } }
    return ""
  }
  /// zone before a cue: from the last comma/semicolon/colon
  func zoneBefore(_ s: String, _ lower: String.Index) -> String {
    let zone = String(s[s.startIndex..<lower])
    let cut = zone.lastIndex(where: { ",;:".contains($0) })
    return cut.map { String(zone[zone.index(after: $0)...]) } ?? zone
  }
  for raw in splitSentences(p.text) {
    let s0 = raw.trimmingCharacters(in: .whitespaces)
    if s0.isEmpty { continue }
    let s = abbrProtect(s0)
    var hit: (cue: String, term: String)? = nil
    var rejectReason = ""
    // one hit per pattern type; "das heißt"/"d. h." excluded ("das" is not a definition cue)
    for m in namedTermRe.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
      guard let r = Range(m.range, in: s) else { continue }
      let pat = String(s[r]).lowercased()
      if pat.hasSuffix("heißt") || pat.hasSuffix("heisst") || pat.hasSuffix("heißen") || pat.hasSuffix("heiße") {
        let pre = String(s[s.startIndex..<r.lowerBound]).trimmingCharacters(in: .whitespaces).lowercased()
        if pre.hasSuffix("das ") || pre.hasSuffix("d∯ h ") || pre.hasSuffix("d.∯h.") || pre == "das" { continue }
      }
      let zb = zoneBefore(s, r.lowerBound)
      var cands: [String] = []
      if pat.hasSuffix("genannt") {
        // run 10: nearestCapBefore only sees the zone since the last comma — in "Diese Luft wird daher auch Totluft
        // genannt" that zone is "Diese Luft " and it grabs "Luft"; when the cue itself contains "wird/werden" the term
        // sits INSIDE the span, directly before "genannt" ("Totluft")
        // match against the RAW span (pat is lowercased for the branch tests; "Totluft" only survives there)
        let rawSpan = String(s[r.range])
        let cueCap = rxc("([A-ZÄÖÜ][\\wäöüß-]+)\\s+genannt$").firstMatch(in: rawSpan, range: NSRange(rawSpan.startIndex..., in: rawSpan)).flatMap { m2 -> String? in
          Range(m2.range(at: 1), in: rawSpan).map { norm(String(rawSpan[$0])) }
        } ?? ""
        cands = [cueCap, nearestCapBefore(zb), extractBefore(s, before: r.lowerBound), extractAfter(s, after: r.upperBound)]
      } else if pat.hasPrefix("sogenannte") || pat.hasPrefix("sog") {
        // run 10: the ∯-protected "sog." cue reaches this branch now (run 9's hasPrefix("sog.") never matched it)
        // the following noun phrase (up to three words), function-word tail trimmed; never the clause
        let zone = String(s[r.upperBound...])
        let mrun = rxc("[A-ZÄÖÜ][\\wäöüß-]*(?:\\s+[a-zäöüß][\\wäöüß-]+){0,3}").firstMatch(in: zone, range: NSRange(zone.startIndex..., in: zone))
        let rawT = mrun.flatMap { Range($0.range, in: zone).map { norm(String(zone[$0])) } } ?? ""
        cands = [trimTermTail(rawT)]
      } else if pat.hasSuffix("heißt") || pat.hasSuffix("heisst") || pat.hasSuffix("heißen") || pat.hasSuffix("heiße") {
        // run 9 fallback: the last capitalised word anywhere before the cue ("… ist die Hydraulik … Übergrundwellengeschwindigkeit heißt …")
        let z = String(s[s.startIndex..<r.lowerBound])
        let gterm = rxc("[A-ZÄÖÜ][\\wäöüß-]{2,}").matches(in: z, range: NSRange(z.startIndex..., in: z)).last.flatMap { m2 -> String? in
          Range(m2.range, in: z).map { norm(String(z[$0])) }
        } ?? ""
        cands = [extractBefore(s, before: r.lowerBound), extractAfter(s, after: r.upperBound), gterm]
      } else {
        // "spricht man von X" / "nennt man X": the term usually follows (von/als + noun, run 9); then the noun phrase
        // before/after; last resort the nearest capitalised word before the cue across a gap without prepositions
        let afterPrep = capAfterPrep(s, from: r.upperBound)
        let gtermz = nearestCapBefore(zb)
        cands = [extractAfter(s, after: r.upperBound), afterPrep, extractBefore(s, before: r.lowerBound), gtermz]
      }
      let t = pick(cands)
      if !t.isEmpty { hit = (String(s[r]), t); break }
      // remember the first non-empty capture's rejection reason for the log
      if rejectReason.isEmpty {
        for c in cands where !c.isEmpty { let (_, why, _) = okTerm(c); rejectReason = "reject:" + why; break }
      }
    }
    // indicator cue: "X sind ein (sichtbares) Anzeichen für Y" — the term is X before the verb and may head its sentence
    if let m = anzeichenRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range, in: s) {
      let t = pick([extractBefore(s, before: r.lowerBound)], initialOk: true)
      if !t.isEmpty { hit = (String(s[r]), t) }   // wins over a junk named-term capture of the same sentence
    }
    // condition cue: "überall dort, wo …" (¶65 "Mountain waves können überall dort auftreten, wo eine starke Strömung
    // in einer stabilen Atmosphäre auf eine Barriere trifft") — no named term, but the sentence is a mandatory fact;
    // run 9 had the cue for ranking only and never made it a fact
    if hit == nil && has(condWhereRe, s) { out.append(("", s0, "überall dort, wo", false, "condition-fact")) }
    // a parenthesis counts only when it renames the noun phrase right before it and holds a term
    if hit == nil {
      for m in rx(#"\(([^()]{3,60})\)"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
        guard let rr = Range(m.range(at: 1), in: s), let outer = Range(m.range, in: s) else { continue }
        let inner = norm(String(s[rr]))
        if inner.contains(",") { continue }                                   // comma list: not a term
        let ws = inner.split(separator: " ")
        if ws.count > 4 { continue }                                          // clause, not a term
        if parenLeadBad.contains(String(ws.first ?? "").lowercased()) { continue }
        let pre = String(s[s.startIndex..<outer.lowerBound])
        let np = extractBefore(pre + " ", before: pre.endIndex)               // the noun phrase before "("
        // run 10: a technical compound inside the parenthesis is a term even when the noun phrase before it is generic
        // ("gesundheitlichen Beschwerden (Föhnkrankheit)" — run 9 dropped this because okTerm("Beschwerden") failed)
        let innerTech = has(techSuffixRe, inner) && okTerm(inner).0
        guard !np.isEmpty, okTerm(np).0 || innerTech else { continue }        // must rename a noun phrase (or hold a technical compound)
        if !okTerm(inner).0 && !has(abbrevTermRe, inner) { continue }         // must hold a term
        hit = ("(" + inner + ")", norm(inner))
        break
      }
    }
    guard let h = hit else {
      if !rejectReason.isEmpty { out.append(("", s0, "", false, rejectReason)) }
      continue
    }
    let (ok, why, term) = okTerm(h.term, initialOk: has(anzeichenRe, abbrProtect(s0)))
    out.append((term, s0, h.cue, ok, ok ? "accepted" : "reject:" + why))
  }
  return out
}

func extractFacts(_ sp: Sec, places: Set<String>, lang: String, stats: inout Stats, factsPath: String, termHitsPath: String) async -> [FactRec] {
  let secId = sp.article + "-" + sp.no
  // run 6 proportional picker: ~1 fact per 80 words, at least one for every paragraph over 60 words (the factsPara
  // top-up below guarantees >=1), at most 2 per paragraph (enforced in consider)
  let big = sp.paras.filter { $0.words > 60 }
  let n = min(8, max(1, Int((Double(sp.words) / 80).rounded()), big.count))
  var recs: [FactRec] = []
  var rejected: [[String: Any]] = []
  func consider(_ f: Fact, named: Bool, term: String) {
    let q = norm(f.quote), st = norm(f.statement)
    // run 9 verbatim check: tag-stripped canonical text + dash/quote normalisation + in-order content-word fallback
    let verb = quoteVerbatim(f.quote, sp.text)
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
  // rule 2: when the cap is reached, condition sentences (bei/wenn/nach/sobald, "überall dort, wo", "wenn … trifft")
  // and indicator sentences ("X sind ein Anzeichen für Y") outrank history/biography sentences
  func rank(_ f: Fact) -> Int {
    let q = f.quote
    var r = 0
    if has(condRe, q) || has(condWhereRe, q) { r += 2 }
    if has(anzeichenRe, abbrProtect(q)) { r += 2 }
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
  // rule 1: every accepted named-term sentence is a mandatory fact, outside the per-paragraph cap (code regex, no model needed for the hit itself);
  // rejected captures are logged with their reason only
  var hits: [[String: Any]] = []
  for p in sp.paras {
    for h in namedTermSentences(p, places: places) {
      if !h.accepted {
        // run 10: a condition sentence ("überall dort, wo …") carries no term but is a mandatory fact anyway (¶65)
        if h.reason == "condition-fact" && !recs.contains(where: { $0.para == p.no && canonV(norm($0.quote)).contains(canonV(norm(h.sent))) }) {
          consider(Fact(quote: norm(h.sent), statement: "Bedingung: \(norm(h.sent))"), named: false, term: "")
        }
        hits.append(["article": sp.article, "section": sp.no, "para": "¶\(p.no)", "term": h.term, "cue": h.cue, "sentence": h.sent,
                     "accepted": false, "reason": h.reason, "becameCard": recs.contains(where: { $0.para == p.no && canonV(norm($0.quote)).contains(canonV(norm(h.sent))) })])
        continue
      }
      // run 9 dedup: a model fact already standing on the term sentence (canonical containment, not exact string)
      let covered = recs.contains(where: { $0.para == p.no && canonV(norm(h.sent)).contains(canonV($0.quote)) })
      if !covered {
        // run 9 dedup: a term already introduced by another fact of the same paragraph adds no card
      if recs.contains(where: { $0.para == p.no && !$0.term.isEmpty && $0.term.lowercased() == h.term.lowercased() }) {
        hits.append(["article": sp.article, "section": sp.no, "para": "¶\(p.no)", "term": h.term, "cue": h.cue, "sentence": h.sent,
                     "accepted": true, "reason": "skip:duplicate-term", "becameCard": false])
        continue
      }
        let st = "Fachbegriff „\(h.term)“: \(norm(h.sent))"
        consider(Fact(quote: h.sent, statement: st), named: true, term: h.term)
      } else if let i = recs.firstIndex(where: { $0.para == p.no && canonV(norm(h.sent)).contains(canonV($0.quote)) }) {
        recs[i].namedTerm = true; recs[i].term = h.term
      }
      hits.append(["article": sp.article, "section": sp.no, "para": "¶\(p.no)", "term": h.term, "cue": h.cue, "sentence": h.sent,
                   "accepted": true, "reason": h.reason,
                   "becameCard": recs.contains(where: { $0.para == p.no && $0.namedTerm && $0.term.lowercased() == h.term.lowercased() })])
    }
  }
  for h in hits { appendLine(termHitsPath, line(h)) }
  // run 10 spec item 1: dedupe FACTS before card generation — same quote span (canonical containment) or >=70%
  // statement overlap keeps one fact (the named-term one wins); this stops duplicate cards at the source
  var deduped: [FactRec] = []; var droppedFacts = 0
  for f in recs {
    if let k = deduped.firstIndex(where: { g in
      let a = canonV(norm(g.quote)), b = canonV(norm(f.quote))
      return (a.contains(b) || b.contains(a) || overlapFrac(g.statement, f.statement) >= 0.7) && !(g.namedTerm && !f.namedTerm) }) {
      if f.namedTerm && !deduped[k].namedTerm { deduped[k].namedTerm = true; deduped[k].term = f.term }
      droppedFacts += 1; continue
    }
    deduped.append(f)
  }
  stats.factsDroppedDup = droppedFacts
  for f in deduped {
    stats.facts += 1; if !f.verbatim { stats.factQuoteBad += 1 }
    appendLine(factsPath, line(["article": sp.article, "section": sp.no, "heading": sp.heading, "statement": f.statement, "quote": f.quote, "quoteVerbatim": f.verbatim, "para": "¶\(f.para)", "paraGuessed": f.guessed, "namedTerm": f.namedTerm, "term": f.term, "target": n]))
  }
  for r in rejected { appendLine(factsPath, line(["article": sp.article, "section": sp.no, "rejectedFact": r])) }
  return deduped
}

let softFlags: Set<String> = ["prefixStripped", "unsupportedVerdict", "quoteNotVerbatim", "stemDemonstrative", "verdictError", "backDeduped", "frontDemonstrative", "paraGuessed", "backTooLongQuote"]
func isAccepted(_ flags: [String]) -> Bool { flags.allSatisfy { softFlags.contains(flagKey($0)) } }
func isClean(_ flags: [String]) -> Bool { flags.allSatisfy { $0 == "prefixStripped" || $0 == "backDeduped" } }

struct FC { var sec: Sec; var fact: FactRec; var front: String; var back: String; var quote: String; var flags: [String]; var accepted: Bool }

/// run 9 calibrated frontContainsAnswer: the back's KEY content = its content words minus the section heading and
/// minus the question-word list (the words any question of this article would share with any answer). Flag only when
/// >=80% of those distinguishing words already sit in the front. Run 8's flat ">=60% of ALL back words in the front"
/// fired on 58% because a question and its answer necessarily talk about the same topic.
let qWordList: Set<String> = ["was","wie","wann","wo","woher","wovor","woraus","warum","weshalb","wodurch","womit",
  "welche","welcher","welches","welchen","welchem","inwiefern","inwieweit","ob"]
func frontContainsAnswerCal(_ f: String, _ b: String, heading: String) -> (Bool, Double) {
  let sb = stems(b)
  if sb.count < 4 { return (false, 0) }
  let fw = stems(f).subtracting(qWordList.map { String($0.prefix(5)) })
  let hw = stems(heading).subtracting(qWordList.map { String($0.prefix(5)) })
  let key = sb.subtracting(hw)            // distinguishing words: back content minus the heading's topic words
  if key.count < 3 { return (false, 0) }
  let frac = Double(key.intersection(fw).count) / Double(key.count)
  return (frac >= 0.8, frac)
}

@main struct Pipeline {
  static func main() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    let a = CommandLine.arguments
    let input = a[1], out = a[2], lang = a.count > 3 ? a[3] : "German"
    let modes = a.count > 4 ? a[4].components(separatedBy: ",") : ["flash", "sum"]
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
    // place names per article ("in X" in the text): never a technical term
    var placesByArticle: [String: Set<String>] = [:]
    for sp in secs { placesByArticle[sp.article, default: []].formUnion(placeNames(sp.text)) }
    var report: [String: Stats] = [:]
    var fcs: [FC] = []

    // ---------------- 8a flashcards ----------------
    if modes.contains("flash") {
      let path = "\(out)/flashcards.jsonl", fpath = "\(out)/facts-flash.jsonl", tpath = "\(out)/named-terms.jsonl"
      for p in [path, fpath, tpath] { try? "".write(toFile: p, atomically: true, encoding: .utf8) }
      var st = Stats(); let t0 = Date()
      let base = "You write flashcards from the given text only, in \(lang). Everything must be supported by the text. If the text contains a garbled formula, a lost symbol or an inconsistent number, do not build a card on it. Never ask about figures or tables. Write ONE flashcard about the given fact: the front is a QUESTION in German that starts with a W-question word and names its subject explicitly, never a bare term and never 'diese Effekte', 'solche', 'dies' without saying what is meant. Pick the question word that fits the answer: 'Was…?' for a thing or definition; 'Wie…?' for a manner or process ('Wie verhält sich die Atmosphäre wie?'); 'Wann…?' for a time or condition ('Wann spricht man vom Föhnsturm?'); 'Wo…?' for a place; 'Wozu…?' for a purpose ('Wozu benötigt die Thermik Warmluft?'); 'Warum/Wodurch…?' for a cause — never force 'Was' where the answer is not a thing. The back is a short precise answer (one or two sentences, no sentence twice and no paraphrase of it either) in the wording of the text that keeps every technical term and every number with unit of the supporting quote; supportingQuote copied verbatim from the text."
      // run 10: fronts plus the fact statement they were built on — a clash needs BOTH a Jaccard >= 0.7 front AND a
      // >= 0.5 overlap of the two facts (Glidr's run-9 score: min-normalised overlap dropped 20 unique cards)
      var frontsByArticle: [String: [(front: String, fact: String)]] = [:]
      for sp in secs {
        let secId = sp.article + "-" + sp.no
        let fl = await extractFacts(sp, places: placesByArticle[sp.article] ?? [], lang: lang, stats: &st, factsPath: fpath, termHitsPath: tpath)
        for fact in fl {
          var logs: [CallLog] = []
          func gen(hint: String?, avoid: [String]) async -> Flashcard? {
            var prompt = "Section title: \(sp.heading)\n\nText:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\n\nWrite one flashcard in \(lang) that tests exactly this fact. The front is a question naming the subject of the section/fact explicitly, with the RIGHT question word: 'Was…?' only when the answer is a thing or definition; otherwise 'Wie…?' (manner/behaviour), 'Wann…?' (time/condition), 'Wo…?' (place), 'Wozu…?' (purpose), 'Warum…?' (cause). Examples: 'Wie verhält sich die Atmosphäre wie?', 'Wann spricht man vom Föhnsturm?', 'Wozu benötigt die Thermik Warmluft von unten?'"
            if !avoid.isEmpty { prompt += "\nalready asked: " + avoid.joined(separator: " | ") + "; ask about a different detail of the quote" }
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
            // run 9: canonical verbatim (tags stripped, dashes/quotes unified, in-order content-word fallback)
            if !quoteVerbatim(c.supportingQuote, sp.text) { flags.append("quoteNotVerbatim") }
            let kw = words(c.back); let pw = Set(words(sp.text))
            let missing = kw.filter { !pw.contains($0) }
            if kw.isEmpty || Double(missing.count) / Double(kw.count) > 0.5 { flags.append("answerWordsMissing:" + missing.joined(separator: ",")) }
            if norm(c.front).isEmpty || norm(c.back).isEmpty { flags.append("emptySide") }
            else if norm(c.back).hasSuffix(":") || c.back.split(separator: " ").count < 2 { flags.append("backStub") }
            // rule 3: fronts in question form; a bare term is rejected. Wie/Wann/Warum/Wodurch are allowed (no forced "Was ist")
            if !norm(c.front).isEmpty && !isQuestion(c.front) && !(c.front.contains("?") && c.front.split(separator: " ").count >= 5) { flags.append("frontNotQuestion") }
            // rule 6a: a truncated side ending in an ellipsis is rejected
            if norm(c.front).hasSuffix("…") || norm(c.front).hasSuffix("...") { flags.append("frontTruncated") }
            if norm(c.back).hasSuffix("…") || norm(c.back).hasSuffix("...") { flags.append("backTruncated") }
            // rule 9b: a front that contains the answer is rejected only when >=80% of the back's DISTINGUISHING
            // words (back content minus heading and question-word list) already sit in the front
            if !norm(c.front).isEmpty && !norm(c.back).isEmpty {
              let (fca, frac) = frontContainsAnswerCal(c.front, c.back, heading: sp.heading)
              if fca { flags.append(String(format: "frontContainsAnswer:%.0f%%", frac * 100)) }
            }
            // rule 5: termsLost on the restricted set only (capitalised non-initial nouns, numbers with units, the named term);
            // at most one lost term, and never the named term or a number-with-unit
            let tl = techTerms(fact.quote).filter { !norm(c.back).lowercased().contains($0) }
            let numLike = tl.filter { $0.first?.isNumber ?? false }
            let namedLost = fact.namedTerm && !fact.term.isEmpty && !norm(c.back).lowercased().contains(norm(fact.term).lowercased())
            if !numLike.isEmpty || namedLost || tl.count > 1 {
              var lostList = Array(tl.prefix(6))
              if namedLost && !lostList.contains(where: { $0 == norm(fact.term).lowercased() }) { lostList.insert(norm(fact.term).lowercased(), at: 0) }
              flags.append("termsLost:" + lostList.prefix(6).joined(separator: ","))
            }
            // rule 6c: a long back that faithfully quotes a named-term sentence is review, not rejection
            let faithfulQuote = fact.namedTerm && (norm(c.back).lowercased().contains(norm(fact.quote).lowercased()) || contentOverlap(c.back, fact.quote) >= 0.85)
            if norm(c.back).count > 350 { flags.append(faithfulQuote ? "backTooLongQuote" : "backTooLong") }
            if !norm(c.back).isEmpty && norm(c.front).lowercased().contains(norm(c.back).lowercased()) { flags.append("backInFront") }
            if has(demoRe, c.front) { flags.append("frontDemonstrative") }
            return (c, flags)
          }
          let hardRegen: Set<String> = ["quoteNotVerbatim", "frontDemonstrative", "answerWordsMissing", "emptySide", "backStub", "backTooLong", "backInFront", "frontNotQuestion", "termsLost", "frontClash", "frontTruncated", "backTruncated", "frontContainsAnswer"]
          guard var c0 = await gen(hint: nil, avoid: []) else {
            appendLine(path, line(["article": sp.article, "section": sp.no, "fact": fact.statement, "error": "generation failed"])); continue
          }
          // run 10 rule 3: fronts unique per article, but a clash means Jaccard >= 0.7 on the front stems AND the same
          // fact (statement overlap >= 0.5) — a shared topic word ("Was ist Thermik?") is NOT a duplicate any more
          var frontClash = false
          if isQuestion(c0.front) {
            st.cardsCheckedForClash += 1
            let used = frontsByArticle[sp.article] ?? []
            func clashes(_ f: String) -> (String, String)? {
              for e in used where jaccard(e.front, f) >= 0.7 && overlapFrac(e.fact, fact.statement) >= 0.5 { return (e.front, e.fact) }
              return nil
            }
            if let (cf, _) = clashes(c0.front) {
              frontClash = true; st.frontClashes += 1
              if let c2 = await gen(hint: "already asked: \(cf); ask about a different detail of the quote", avoid: used.map { $0.front }) { c0 = c2 }
            }
          }
          var (c, flags) = checks(c0); var regen = false; var first: [String] = []
          if frontClash { first.append("frontClash") }
          // a regenerated card is checked for a clash too (drop only when the SECOND attempt clashes as well)
          if !frontClash && isQuestion(c.front), let (cf, _) = ({ () -> (String, String)? in
            for e in frontsByArticle[sp.article] ?? [] where jaccard(e.front, c.front) >= 0.7 && overlapFrac(e.fact, fact.statement) >= 0.5 { return (e.front, e.fact) }
            return nil })() {
            frontClash = true; st.frontClashes += 1; first.append("frontClash")
            if let c2 = await gen(hint: "already asked: \(cf); ask about a different detail of the quote", avoid: (frontsByArticle[sp.article] ?? []).map { $0.front }) { regen = true; st.regenerated += 1; (c, flags) = checks(c2) }
          }
          let need = flags.map(flagKey).filter { hardRegen.contains($0) } + (frontClash ? ["frontClash"] : [])
          if !need.isEmpty {
            first = flags.isEmpty ? first : flags; for f in Set(need) { st.regenReason[f, default: 0] += 1 }
            var why = "the front must be a question ('Was…?', 'Wie…?', 'Wann…?', 'Warum…?', 'Wodurch…?') naming its subject (no bare term, no 'diese'/'solche'/'dies'), it must NOT repeat the answer (do not put the back's content words into the question), never end in '…', the quote copied exactly from the text, and the back must keep every technical term and number-with-unit of the supporting quote"
            // run 10 (Glidr's score): the lost tokens go into the keep-regeneration prompt VERBATIM, in their original
            // spelling ("Die Rückseite muss '0,6 °C pro 100 m' enthalten") — run 9 lowercased them and the number stayed lost
            if need.contains("termsLost") {
              var lost = techTerms(fact.quote).filter { t in
                let parts = norm(t).split(separator: " ").map(String.init)
                return !parts.allSatisfy { norm(c.back).lowercased().contains($0.lowercased()) }
              }
              if fact.namedTerm && !fact.term.isEmpty && !norm(c.back).lowercased().contains(norm(fact.term).lowercased()) { lost.insert(fact.term, at: 0) }
              if !lost.isEmpty { why += " — Die Rückseite muss wörtlich enthalten: „" + Array(Set(lost)).joined(separator: ", ") + "“." }
            }
            if let c2 = await gen(hint: "A previous attempt (front: \(c.front)) was rejected for: \(need.joined(separator: ", ")). " + why + ".", avoid: (frontsByArticle[sp.article] ?? []).map { $0.front }) { regen = true; st.regenerated += 1; (c, flags) = checks(c2) } else { st.regenFailed += 1; flags.append("regenFailed") }
          }
          // after the single regeneration a still-clashing front is dropped (fronts stay unique per article)
          var dropped = false
          let usedNow = frontsByArticle[sp.article] ?? []
          let stillClash = usedNow.contains(where: { jaccard($0.front, c.front) >= 0.7 && overlapFrac($0.fact, fact.statement) >= 0.5 })
          if !stillClash && isQuestion(c.front) { frontsByArticle[sp.article, default: []].append((front: norm(c.front).lowercased(), fact: fact.statement)) }
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

    // ---------------- 8c map-reduce summaries: combine selects and orders map bullets VERBATIM (no rewriting) ----------------
    var sumSt = Stats(); var sumBullets = 0, sumBulletsLow = 0, sumDup = 0, sumAdded = 0, sumRefIssues = 0
    var sumDroppedUnsupported = 0, sumEitherOder = 0, sumDebrisStripped = 0, sumFormulaDropped = 0
    var sumBulletsUnsupported = 0   // run 10: map bullets dropped by the named-term/number support + causal-connector check
    var sumCoverage: [String] = []
    if modes.contains("sum") {
      let path = "\(out)/summaries.jsonl"; try? "".write(toFile: path, atomically: true, encoding: .utf8)
      let t0 = Date()
      for article in Array(Set(secs.map { $0.article })).sorted() {
        var flat: [(sec: String, text: String)] = []
        var mapMs = 0
        for sp in secs where sp.article == article {
          let secId = sp.article + "-" + sp.no
          // formula debris stripped in CODE before the map: lines that are mostly symbols/digits never reach the model
          let (cleanText, debrisLines) = stripFormulaLines(sp.text)
          sumFormulaDropped += debrisLines
          let r = await call(SectionBullets.self, instructions: "You summarise a textbook section in \(lang), from the text only. Two or three short bullets, one sentence each. Prefer definitions, causes and rules. No references, no section numbers.",
                             prompt: "Section title: \(sp.heading)\n\nSection:\n\n\(cleanText)\n\nSummarise in 2 to 3 bullets in \(lang).")
          sumSt.add(CallLog(name: "mapSummary", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId); mapMs += r.ms
          var bl: [String] = []
          if let v = r.value { bl = v.bullets.map { norm($0) } } else { sumSt.errors += 1 }
          // a map bullet that still carries formula debris or source-number debris is dropped/stripped in code
          var kept: [String] = []
          for b in bl { let (s, ch) = stripDebris(b); if !s.isEmpty { kept.append(s); if ch { sumDebrisStripped += 1 } } else { sumFormulaDropped += 1 } }
          bl = kept
          let pw = Set(words(cleanText)); var low = 0
          for b in bl { let kw = words(b); if !kw.isEmpty && Double(kw.filter { !pw.contains($0) }.count) / Double(kw.count) > 0.5 { low += 1 } }
          // run 10 spec 3a: per-bullet support check against its OWN section on named-term/number tokens (not generic
          // content-word overlap), plus the causal-connector rule: a bullet with durch/da/weil/wodurch/deshalb must have
          // that connector in some sentence of the section (run 9's invented §02/§03 bullets pass neither)
          let secTT = Set(techTerms(sp.text).map { $0.lowercased() })
          func techSupported(_ b: String) -> Bool {
            let bt = techTerms(b)
            if bt.isEmpty { return true }   // no technical tokens to check: keep (generic-word overlap is not the test)
            var hit = 0
            for t in bt {
              let parts = norm(t).split(separator: " ").map { $0.lowercased() }
              if secTT.contains(norm(t).lowercased()) || parts.allSatisfy { sp.text.lowercased().contains($0) } { hit += 1 }
            }
            return Double(hit) / Double(bt.count) >= 0.6
          }
          let causalRe = rx(#"\b(durch|da|weil|wodurch|deshalb)\b"#)
          let secSents = sp.paras.flatMap { splitSentences($0.text) }
          var supDroppedHere = 0
          bl = bl.filter { b in
            if !techSupported(b) { supDroppedHere += 1; return false }
            if has(causalRe, b) && !secSents.contains(where: { has(causalRe, $0) && contentOverlap($0, b) >= 0.35 }) { supDroppedHere += 1; return false }
            return true
          }
          sumBulletsUnsupported += supDroppedHere
          sumBullets += bl.count; sumBulletsLow += low
          for b in bl { flat.append((sp.no, b)) }   // the bullet keeps its own section id (§NN), never a chunk index
          appendLine(path, line(["stage": "map", "article": article, "section": sp.no, "sectionRef": "§\(sp.no)", "history": sp.history, "bullets": bl.map { $0 + " (§\(sp.no))" }, "lowOverlapBullets": low,
                                 "formulaLinesStrippedBeforeMap": debrisLines,
                                 "ms": r.ms, "tokens": ["in": r.tokensIn, "out": r.tokensOut], "error": r.error ?? NSNull()]))
          say("sum map \(secId) \(bl.count) bullets \(r.ms) ms")
        }
        let numbered = flat.enumerated().map { "\($0.offset + 1). [§\($0.element.sec)] \($0.element.text)" }.joined(separator: "\n")
        // the combine step does NOT rewrite: it picks input bullet numbers and orders them; texts stay verbatim
        // run 10 spec 3b: the quota is stated to the model (every section at least once, always keep a bullet with a
        // named term or a number+unit); invalid picks are logged with their raw sources and the reason why they failed
        let insC = "You order section summaries into one article summary. You do NOT rewrite, merge or rephrase any bullet: for every output bullet give exactly ONE number of an input bullet (the leading number of the line), and the text you repeat is ignored (the code keeps the input bullet word for word). Choose 6 to 10 bullets that cover the whole article: EVERY section number §NN must appear at least once among your choices; always keep a bullet that contains a technical term or a number with a unit; skip redundant ones, order them by topic."
        let r = await call(Combined.self, instructions: insC, prompt: "Article \(article). Numbered section bullets:\n\n\(numbered)\n\nChoose 6 to 10 of these bullets that together cover the whole article without repeating each other, in a sensible order. Every §NN listed above must be represented by at least one chosen bullet; prefer bullets carrying a technical term or a number with unit. For every chosen bullet give its input line number (exactly one per output bullet). Do not write any text.")
        sumSt.add(CallLog(name: "combine", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: article + "-combine")
        struct Item { var text: String; var secs: Set<String>; var added: Bool }
        var picked: [Item] = []; var bad = 0; var pickLogs: [PickLog] = []
        if let v = r.value {
          for it in v.items {
            let raw = it.sources.map(String.init).joined(separator: ",")
            let srcs = Array(Set(it.sources.filter { $0 >= 1 && $0 <= flat.count }))
            guard srcs.count == 1 else { bad += 1; pickLogs.append(PickLog(raw: raw, ok: false, why: it.sources.isEmpty ? "no source given" : "not exactly one valid input number (got [\(raw)], \(it.sources.count) values)")); continue }   // one input bullet per output item, its own §id
            let idx = srcs[0] - 1
            if picked.contains(where: { $0.text == flat[idx].text }) { pickLogs.append(PickLog(raw: raw, ok: false, why: "already picked")); continue }
            picked.append(Item(text: flat[idx].text, secs: [flat[idx].sec], added: false))
            pickLogs.append(PickLog(raw: raw, ok: true, why: "bullet \(srcs[0]) §\(flat[idx].sec)"))
          }
        } else { sumSt.errors += 1 }
        // code dedup at >=70% content-word overlap (later one dropped, its section joined to the earlier)
        var dedup: [Item] = []; var dups = 0
        for it in picked {
          if let k = dedup.firstIndex(where: { contentOverlap($0.text, it.text) >= 0.7 }) { dedup[k].secs.formUnion(it.secs); dups += 1 } else { dedup.append(it) }
        }
        // run 10 spec 3b quota: every non-history section without a bullet adds its FIRST supported map bullet that
        // carries a named term or a number+unit (falls back to the first bullet of the section); then, over the cap,
        // unsupported bullets are dropped before any bullet carrying a named term/number+unit is ever dropped
        let unitRe = rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#)
        func carriesTech(_ b: String) -> Bool { !techTerms(b).isEmpty || has(unitRe, b) }
        var added = 0
        for sp in secs where sp.article == article && !sp.history {
          if !dedup.contains(where: { $0.secs.contains(sp.no) }) {
            let cand = flat.filter { $0.sec == sp.no }.first(where: { carriesTech($0.text) }) ?? flat.first(where: { $0.sec == sp.no })
            if let f = cand {
              if dedup.contains(where: { contentOverlap($0.text, f.text) >= 0.7 }) { dups += 1; continue }
              dedup.append(Item(text: f.text, secs: [sp.no], added: true)); added += 1
            }
          }
        }
        if dedup.count > 10 {
          var over = 0
          dedup = dedup.filter { it in
            if dedup.count - over <= 10 { return true }
            if !it.added && !carriesTech(it.text) { over += 1; return false }
            return true
          }
        }
        sumDup += dups; sumAdded += added; sumRefIssues += bad
        let outB = dedup.map { $0.text + " (" + $0.secs.sorted().map { "§\($0)" }.joined(separator: ", ") + ")" }
        let cited = Set(dedup.flatMap { $0.secs })
        let nonHist = secs.filter { $0.article == article && !$0.history }.map { $0.no }
        let rawCount = r.value?.items.count ?? 0
        sumCoverage.append("\(article): non-history sections covered \(nonHist.filter { cited.contains($0) }.count)/\(nonHist.count); combine picked \(rawCount) -> valid \(picked.count) - dedup \(dups) + coverage fallbacks \(added) = \(dedup.count); invalid picks (not exactly one input bullet) \(bad); all texts verbatim map output; raw combine output in this line's 'combineRawItems'")
        appendLine(path, line(["stage": "combine", "article": article, "bullets": outB, "bulletCount": outB.count, "combinedRaw": rawCount, "validPicks": picked.count, "duplicatesMerged": dups, "addedForCoverage": added,
                               "invalidPicks": bad, "verbatimRewrites": 0,
                               // run 10: the raw pick list with the validation reason per pick (run 9's Föhn combine gave
                               // 6 picks and all failed srcs.count == 1 — this log shows what the model returned)
                               "combineRawItems": pickLogs.map { ["sources": $0.raw, "ok": $0.ok, "why": $0.why] },
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
      covMd += "### 8a flashcards (accepted), coverage per paragraph\n\n" + m + "\n"; covJson["flash"] = j
      let (m2, j2) = coverage(fcs.map { ($0.sec.article, $0.sec.no, $0.fact.para) }, label: "all generated flashcards")
      covJson["flashAllGenerated"] = j2; _ = m2
    }
    // earlier-run comparison: paragraph coverage of accepted flashcards of each dir given after the modes arg (run 6, run 7, run 8)
    var r6Cov = ""
    struct RunRow { var name: String; var cards: Int; var accepted: Int; var tokPerAcc: Int; var covBig: Int; var bigTotal: Int; var termHits: [String] }
    var rowsCmp: [RunRow] = []
    let targetTerms = ["Blauthermik","Rückseitenwetter","pulsierende Thermik","Föhnmauer","Föhnfenster","Föhnsturm","Föhnkrankheit","rotor","Cumulus"]
    func termHitsIn(_ cards: [[String: Any]]) -> [String] {
      var got: [String] = []
      for t in targetTerms {
        let tl = t.lowercased()
        if cards.contains(where: { (($0["front"] as? String) ?? "") .lowercased().contains(tl) || (($0["back"] as? String) ?? "").lowercased().contains(tl) }) { got.append(t) }
      }
      return got
    }
    for (ri, prev) in a.dropFirst(5).enumerated() {
      guard let txt = try? String(contentsOfFile: prev + "/flashcards.jsonl", encoding: .utf8) else { continue }
      var keys: [(String, String, Int)] = []
      var cards: [[String: Any]] = []; var accCards: [[String: Any]] = []; var tokAcc = 0
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any] else { continue }
        cards.append(o)
        guard (o["accepted"] as? Bool) == true else { continue }
        accCards.append(o)
        if let ar = o["article"] as? String, let se = o["section"] as? String, let p = o["para"] as? String, let n = Int(p.replacingOccurrences(of: "¶", with: "")) { keys.append((ar, se, n)) }
        // tokens per accepted card: sum of the per-call token maps (runs 6-8 all carry "tokens")
        if let tk = o["tokens"] as? [[String: Any]] { for e in tk { tokAcc += ((e["in"] as? Int) ?? 0) + ((e["out"] as? Int) ?? 0) } }
      }
      let (m, j) = coverage(keys, label: "run \(6 + ri) accepted flashcards")
      r6Cov += "### run \(6 + ri) flashcards (accepted), same measure\n\n" + m + "\n"; covJson["run\(6 + ri)flash"] = j
      let covBig = j["_total"] as? [String: Any] ?? [:]
      rowsCmp.append(RunRow(name: "run \(6 + ri)", cards: cards.count, accepted: accCards.count,
                            tokPerAcc: accCards.isEmpty ? 0 : tokAcc / accCards.count,
                            covBig: (covBig["coveredBig"] as? Int) ?? -1, bigTotal: (covBig["big"] as? Int) ?? 0,
                            termHits: termHitsIn(accCards)))
    }
    // this run's own row, measured identically over the in-memory cards
    if report["flash"] != nil {
      let accFC = fcs.filter { $0.accepted }
      var tokAcc = 0
      // recompute from the jsonl we just wrote (same field layout as earlier runs)
      if let txt = try? String(contentsOfFile: "\(out)/flashcards.jsonl", encoding: .utf8) {
        var accCards: [[String: Any]] = []
        for l in txt.components(separatedBy: "\n") where !l.isEmpty {
          guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any], (o["accepted"] as? Bool) == true else { continue }
          accCards.append(o)
          if let tk = o["tokens"] as? [[String: Any]] { for e in tk { tokAcc += ((e["in"] as? Int) ?? 0) + ((e["out"] as? Int) ?? 0) } }
        }
        // the row number comes from the out dir name (".../run10/" -> 10)
        let digits = a[2].split(separator: "/").filter { $0.hasPrefix("run") }.last.map { $0.dropFirst(3) } ?? "10"
        rowsCmp.append(RunRow(name: "run \(digits.isEmpty ? "10" : digits)", cards: fcs.count, accepted: accFC.count,
                              tokPerAcc: accCards.isEmpty ? 0 : tokAcc / accCards.count,
                              covBig: ((covJson["flash"] as? [String: Any])?["_total"] as? [String: Any])?["coveredBig"] as? Int ?? -1,
                              bigTotal: ((covJson["flash"] as? [String: Any])?["_total"] as? [String: Any])?["big"] as? Int ?? 0,
                              termHits: termHitsIn(accCards)))
      }
    }
    var cmpMd = ""
    if rowsCmp.count >= 2 {
      cmpMd = "\n## comparison table (runs measured on the same sections; tokens per accepted card = in+out of that card's calls)\n\n| run | cards | accepted % | tokens per accepted card | paragraphs > 60 w covered | named-term hits (in accepted front/back) |\n|---|---|---|---|---|---|\n"
      + rowsCmp.map { "| \($0.name) | \($0.cards) | \(pct($0.accepted, $0.cards)) | \($0.tokPerAcc) | \($0.covBig)/\($0.bigTotal) | \($0.termHits.isEmpty ? "—" : $0.termHits.joined(separator: ", ")) |" }.joined(separator: "\n") + "\n"
    }
    if let d = try? JSONSerialization.data(withJSONObject: covJson, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/coverage.json")) }

    // named-term report: every capture with its accept/reject reason, and which accepted terms became cards
    var termMd = ""
    if let txt = try? String(contentsOfFile: "\(out)/named-terms.jsonl", encoding: .utf8) {
      var lines: [(ar: String, se: String, para: String, term: String, cue: String, accepted: Bool, reason: String, became: Bool, sentence: String)] = []
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
              let ar = o["article"] as? String, let se = o["section"] as? String, let term = o["term"] as? String,
              let para = o["para"] as? String, let became = o["becameCard"] as? Bool else { continue }
        lines.append((ar, se, para, term, (o["cue"] as? String) ?? "", (o["accepted"] as? Bool) ?? true, (o["reason"] as? String) ?? "accepted", became, (o["sentence"] as? String) ?? ""))
      }
      // run 9 measure: an accepted term is COVERED when some accepted card of the article carries it (own card or a
      // model fact whose card keeps the term) — this is what run 7's "real hits" counted
      for i in lines.indices where lines[i].accepted && !lines[i].became {
        if fcs.contains(where: { $0.accepted && $0.sec.article == lines[i].ar && termCovered(lines[i].term, sent: lines[i].sentence, front: $0.front, back: $0.back) }) { lines[i].became = true }
      }
      var seenTerms = Set<String>(); var uniq = 0
      for l in lines where l.became && !seenTerms.contains("\(l.ar)-\(l.term.lowercased())") { seenTerms.insert("\(l.ar)-\(l.term.lowercased())"); uniq += 1 }
      let acc = lines.filter { $0.accepted }.count, rej = lines.count - acc
      let rows = lines.map { "| \($0.ar)-\($0.se) | \($0.para) | \($0.term) | \($0.cue) | \($0.accepted ? "accept" : "reject: \($0.reason)") | \($0.became ? "yes" : "no") |" }.joined(separator: "\n")
      termMd = "\n## named-term captures (rule 9a): accept/reject reason per capture\n\n| section | para | term | cue | verdict | covered by an accepted card |\n|---|---|---|---|---|---|\n" + rows + "\n- captures: \(lines.count), accepted: \(acc), rejected: \(rej); accepted terms covered by an accepted card (own or another fact's): \(uniq)\n"
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

      - facts: \(s.facts) (quote not verbatim: \(s.factQuoteBad), rejected by code: \(s.factsRejected), dropped as duplicate facts before card generation: \(s.factsDroppedDup)); cards: \(s.cards); accepted (no hard flag): \(pct(s.accepted, s.cards)), of which review (soft flag): \(s.review); dropped for a duplicate front: \(s.droppedDupFront); call errors: \(s.errors)
      - duplicate fronts (run 10 rule: Jaccard >= 0.7 on the front AND fact overlap >= 0.5): clashes detected \(pct(s.frontClashes, s.cardsCheckedForClash)) of cards checked; run 9's min-overlap rule dropped 23/84 (frontClash 27 first-attempt defects)
      - flag rates (share of cards; a card can carry several):
      \(rates.isEmpty ? "  - none" : rates)
      - regenerated: \(s.regenerated), regeneration failed: \(s.regenFailed); first-attempt defects by reason: \(reg.isEmpty ? "none" : reg)
      - median ms per call: \(calls)
      - ms per section: mean \(secMsAll.isEmpty ? 0 : secMsAll.reduce(0, +) / secMsAll.count), median \(median(secMsAll)), total wall \(s.wallMs) ms (per-section list in timing-sections.json)
      - tokens (in/out): \(s.tokIn)/\(s.tokOut); per accepted card (in+out): \(tpa)
      - ms per accepted card: \(s.accepted == 0 ? "n/a" : "\(s.secMs.values.reduce(0, +) / s.accepted)")
      """
    }
    var md = "# pipeline summary (run 10, \(lang))\n\n- input: \(input) (\(secs.count) sections: \(Set(secs.map { $0.article }).sorted().joined(separator: ", "))); modes: \(modes.joined(separator: ",")); MCQ not run (opt-in)\n" + cmpMd + "\n"
    if let s = report["flash"] { md += block("9a/9b flashcards", s) + "\n" + termMd + "\n" }
    md += "## coverage per paragraph (cards from the paragraph / paragraphs over 60 words)\n\n" + covMd + r6Cov
    if report["sum"] != nil {
      let s = sumSt
      md += "## 9c summaries (run 10: map support check on named-term/number tokens + causal-connector rule, combine quota >= 1 bullet per non-history section, verbatim combine as run 8)\n\n- map calls: \(s.perCall["mapSummary"]?.count ?? 0), median ms \(median(s.perCall["mapSummary"] ?? [])); combine calls: \(s.perCall["combine"]?.count ?? 0), median ms \(median(s.perCall["combine"] ?? []))\n- section bullets: \(sumBullets), with >50% content words missing from the section: \(sumBulletsLow); dropped by the support/causal check: \(sumBulletsUnsupported)\n- formula-debris lines stripped in code BEFORE the map: \(sumFormulaDropped); formula-debris bullets dropped after the map / source numbers \"(1, 3, 4)\" stripped in: \(sumDebrisStripped)\n- combine picks invalid (not exactly one input bullet): \(sumRefIssues); near-duplicate bullets merged in code (>=70% overlap): \(sumDup); coverage fallbacks added (verbatim map bullet of an uncovered section): \(sumAdded)\n- " + sumCoverage.joined(separator: "\n- ") + "\n- tokens (in/out): \(s.tokIn)/\(s.tokOut); total wall \(s.wallMs) ms; call errors \(s.errors)\n- ms per section (map): " + s.secMs.filter { !$0.key.hasSuffix("combine") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ") + "\n\n"
    }
    var timing: [String: Any] = [:]
    for (k, s) in report { timing[k] = s.secMs.mapValues { $0 }.merging(s.secTok.reduce(into: [String: Int]()) { $0[$1.key + ".tokIn"] = $1.value.0; $0[$1.key + ".tokOut"] = $1.value.1 }) { a, _ in a } }
    if let d = try? JSONSerialization.data(withJSONObject: timing, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/timing-sections.json")) }
    try? md.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    say(md)
  }
}
