// Probe run 14 (German): flashcards + summaries only. Builds on run 13 (main, key 8/11, 62/86 accepted, 2 wrong cards).
// Changes vs run 13 (Glidr's run-13 score): 1 duplicate fronts regenerate / code-qualify instead of dropping, only surviving cards
// register fronts; 2 every number+unit sentence yields a fact; 3 finite-verb lexicon (main clauses, separable particles, participles);
// 4 termsLost against the sentence(s) used for the trimmed back, front words kept; 5 typo restore only for out-of-vocabulary words,
// never an inflection; 6 front/back mismatch on stems and hyphen pieces, second front attempt, soft when it survives; 7 junk filter
// before the term template ("das heißt" cue fixed, clause/np-tail junk), dash and compound appositive cues, fronts always "Was ist X?";
// 8 Luv/Lee quote split + merged-back check; 9 pull-in never twice, source order, balanced parentheses, leading "Da" kept;
// 10 summaries: term parentheses kept, forced cap (4 term + 2 number per section), §01 definition always, lowercase/verbless filtered,
// condition sentences forced.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-r14.swift -o $TMPDIR/pipeline-probe-r14
// Run:   $TMPDIR/pipeline-probe-r14 <dir of sections> <out dir> German [flash,sum] [older run dirs for the comparison table]
//        $TMPDIR/pipeline-probe-r14 --selftest [sections dir]
// ---- run 13 changes kept below ----
// Probe run 13 (German): flashcards + summaries only. Builds on run 12 (merged main, key 9/11; with #78 accepted 11/11, 86 % accepted).
// Changes vs run 12 (Glidr's run-12 score):
// A term cards: a namedTerm fact gets the front "Was ist <Term>?" / "Was versteht man unter <Term>?" built IN CODE (the model
//   only writes the back); frontReversed is skipped for them (#78 Rückseitenwetter was lost to it, a false positive). On a front
//   clash with a DIFFERENT back the card is never dropped: a term card gets its code front, otherwise the front is regenerated
//   once more ("was ist <Term>?"-style about this fact); only an identical back drops the card (#76 indifferente Schichtung).
// B no matcher text in the output: lowercased stems and keyword lists never enter fronts/backs (#78 "kaltluftadvektion", #87
//   trailing ", thermik, umgebungsluft, …"); a stripped list tail is dropped from both sides.
// C splitter: "resp." joins the abbreviation list (#82 broke at "resp."); every emitted card text passes through restoreAbbr.
// D termsLost: "engl." is stripped from a captured term ("engl. hydraulic jump" -> "hydraulic jump", #31, third run with it);
//   a term kept by STEM in the back is never reported lost (the lowercased token list is gone).
// E front/back mismatch check: the front's content nouns must appear in the back or in the fact quote, else ONE regeneration
//   (#8 #10 copied #3's back-template into their fronts; Südföhn/Nordföhn).
// F finite-verb check on EVERY sentence of the back, not just after trimming (#52 #54 #81 fragments); the same per-sentence verb
//   test guards summary bullets.
// G a word that is neither verbatim in the fact quote nor anywhere in the section: when it differs from exactly one source word
//   by ONE edit it is RESTORED to the source spelling, else the card is rejected (#18 "abgeregierte" -> "abgeregnete", 4th run).
// H demonstratives in the factQuote ("Diese Leewellen …") pull the previous source sentence into the quote BEFORE the back is
//   written (#48 Föhnlinsen inverted its subject — the only wrong card of run 12).
// I junk terms: Umgebung, place names (Freiburg), quoted words (‚Fallwind), value descriptions ("kleiner Albedowert"), clause
//   captures ("Wasser strömt langsamer", "Geschwindigkeit strömendes"); the "sog§§" placeholder never leaks into a logged cue.
// J summaries: force-include BEFORE the quota every sentence carrying an ACCEPTED named term (from the run's own captures) or a
//   number+unit, and it is NEVER dropped by the over-cap cut; then at most ONE free model pick per section (run 12 Thermik missed
//   Cumulus/Blauthermik/Schichtung/Rückseitenwetter, Föhn missed the 0,6 °C sentence). Sort, demonstrative pull-in and the
//   ":"/verbless/debris rules are kept.
// ---- run 12 changes kept below ----
// Probe run 12 (German): flashcards + summaries only. Builds on run 11 (merged main, key number 9/11, 0 wrong cards).
// Changes vs run 11 (Glidr's run-11 score — polish without regressions):
// A over-firing checks fixed (~8 good cards were rejected): ALL comparisons run on STEMS — German endings -es/-s/-er/-en/-e/-em
//   stripped ("pulsierender Thermik" == "pulsierende Thermik", "Aufwinds" == "Aufwindes"); answerWordsMissing only counts
//   NOUNS and numbers, looked up SECTION-WIDE (verbs the model legitimately adds — "entstehen", "erfolgt" — and translated
//   terms like "Bergwellen" for "mountain waves" no longer kill a card); termsLost runs against the SENTENCE ACTUALLY USED
//   for the back, not the whole factQuote (#50 keeps its card); backTrimmed is SOFT (never hard, #70); the abbreviation
//   placeholder §§ is restored before any term/output use (the "engl∯ hydraulic jump" leak of #34).
// B fronts: a front Jaccard >= 0.9 ALWAYS clashes regardless of the back (#1/#5 "Was entsteht der Föhn?" were both kept);
//   a trimmed or deduped back that lost its finite verb falls back to the full sentence (never a verbless fragment, #38 #52);
//   a back starting with a demonstrative ("Diese Luft …") pulls in the previous source sentence (#48 Totluft); grammar
//   check on fronts: no finite verb -> frontNoFiniteVerb; a dangling article or "die Zahl" without an antecedent ->
//   frontDanglingAntecedent.
// C junk filter + formula check applied to the PARENTHESIS capture path too (der Deutsche, Ablösung tritt, Julius, Bart,
//   τTh−τLu never become named terms).
// D summaries stay EXTRACTIVE; exam weighting in code: every sentence carrying a detected named term or a number+unit is
//   FORCE-INCLUDED as a bullet; a picked sentence starting with a demonstrative (Diese/dieser/solche/Das führt …) pulls the
//   previous source sentence; sentences ending in ":" and verbless list items are dropped; " ," / " ." debris collapsed;
//   bullets sorted by § and sentence index. --selftest extended with the run-12 cases.
// ---- run 11 changes kept below ----
// Probe run 11 (German): flashcards + summaries only. Builds on run 10 (merged main). Changes vs run 10 (Glidr's run-10 score):
// A named-term detector extracted into a PURE function (namedTermSentences takes the paragraph text, no Para struct) plus a
//   --selftest mode that runs the six Glidr sentences (¶8 ¶10 ¶19 ¶20 ¶62 ¶65, plus ¶74 sog. and a junk sentence) with swift
//   asserts BEFORE any run: "spricht man von X" captures ADJ+NOUN inflected and dictionary-forms it ("pulsierender Thermik"
//   -> "pulsierende Thermik"); NO one-hit-per-paragraph cap (¶8 keeps Blauthermik next to the Cumulus hit); "sog." matches
//   (the abbreviation protection must not eat the cue; ¶20 Rückseitenwetter, ¶74 Albföhn); "(stabile/indifferente/labile
//   Schichtung)" captured — a term parenthesis no longer has to rename a noun phrase; the "überall dort, wo" cue fires as a
//   condition fact; the junk filter runs AFTER capture (empty, Föhn, Umgebung, ‚der Deutsche, "Ablösung tritt", generic
//   single words, years).
// B flashcards: backTooLong TRIMS to the sentence holding the term/number instead of rejecting (q176 "etwa 0,6 °C/100 m");
//   the formula-debris filter applies to fact quotes on flash facts too (¶36 trap); duplicate rule becomes (front Jaccard
//   >= 0.7 AND back overlap >= 0.7) OR back overlap >= 0.9; the "Wie verhält sich X wie?" template example is removed and a
//   front ending in "wie?" is rejected; a REVERSED front (the answer term asked as the question's subject, "…die Intensität?")
//   is rejected; EVERY content word of the back must exist in the section text (catches "abgeregierte"-style typos); the ¶
//   label comes from where the factQuote is found in the section, not from the model.
// C summaries: EXTRACTIVE map — the model picks source SENTENCE INDICES from a numbered list, code takes those sentences
//   VERBATIM and trims parentheticals; no free rewrite (run 10's Föhn map invented 4 of 12 bullets). The per-section quota
//   and the named-term/number keep rule stay; combine keeps bullets verbatim as before.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-r12.swift -o $TMPDIR/pipeline-probe-r12
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-r13.swift -o $TMPDIR/pipeline-probe-r13
// Run:   $TMPDIR/pipeline-probe-r13 <dir of sections> <out dir> German [flash,sum] [older run dirs for the comparison table]
//        $TMPDIR/pipeline-probe-r13 --selftest  (named-term detector unit test, no model calls)
// ---- run 10 changes kept below ----
// Probe run 10 (German): flashcards + summaries only. Builds on run 9 (merged main). Changes vs run 9 (Glidr's run-9 score):
// A duplicate fronts: a clash needs Jaccard >= 0.7 on front content-word stems AND >= 0.5 overlap of the two facts'
//   statements (run 9's min-normalised >=0.85 dropped 23 cards, only 3 real dupes); the clash hint names the clashing
//   front ("already asked: <front>; ask about a different detail of the quote"); a second clash drops the card.
//   FACTS are deduped before card generation too (same canonical quote span or >=0.7 statement overlap -> keep one).
// B named terms: "sog." cue fixed for the §§-protected form ("dem sog. Rückseitenwetter" was never matched); the
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
/// run 11 EXTRACTIVE map: the model does not write bullets, it picks the NUMBERS of the source sentences (the leading
/// number of each line); code takes those sentences verbatim and trims parentheticals in code
@Generable struct SectionPick: Codable {
  @Guide(description: "the numbers of the section sentences to keep as summary bullets, at most three", .maximumCount(3)) var picks: [Int]
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
/// abbreviations whose period must not end a sentence (protected with §§ before splitting and matching)
// run 13 (Glidr's #82): "resp." was missing and the splitter broke there ("… des elektrischen Feldes resp. dessen
// Gradienten …" became two fragments that backDeduped glued back together); all of resp./bzw./ca./u. a./u. U./z. B./sog./engl.
// are listed (verified against the sections: resp., bzw., ca., sog., engl., u. a., u. U., z. B. all occur). The second "d. h."
// entry keeps its non-breaking space on purpose — it protects the NBS spelling too.
let abbrList = ["sog.", "z. B.", "z.B.", "u. U.", "u.U.", "u. a.", "bzw.", "ca.", "resp.", "d. h.", "d. h.", "vs.", "usw.", "etc.", "vgl.", "engl.", "ff.", "u. s. w."]
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
      for d in abbrList { body = body.replacingOccurrences(of: d, with: d.replacingOccurrences(of: ".", with: "§§")) }
      // run 12: the paragraph text KEEPS the §§ protection (run 11 restored it here and splitSentences re-protected,
      // which lost the space of multi-dot abbreviations: "z. B." -> "z∯B∯" -> "z.B."); only the ∯-style leak is fixed
      body = norm(body)
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
/// sentences split at [.!?] + whitespace; "bzw.", "z. B." etc. are protected by the §§ marker set in cleanSection
func splitSentences(_ s: String) -> [String] {
  // run 11: abbreviation dots are protected HERE (the old lookbehind included §§ and split "sog. Rückseitenwetter")
  abbrProtect(s).replacingOccurrences(of: #"(?<=[.!?])\s+"#, with: "\n", options: .regularExpression).components(separatedBy: "\n")
    .map { $0.replacingOccurrences(of: "§§", with: ".") }
}
/// run 12: German STEMS (endings -es/-s/-er/-en/-e/-em stripped), not 5-char prefixes — "Aufwinds" == "Aufwindes",
/// "pulsierender" == "pulsierende"; every overlap/jaccard/dup comparison in the pipeline uses this now
func stems(_ s: String) -> Set<String> { stemWords(s) }
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
  // run 12 (Glidr's #38/#52): a dedupe may leave a verbless fragment ("Bei Südföhn in Innsbruck einen … belegen");
  // when any kept sentence lost its finite verb, keep the FULL text instead of the fragment
  if dropped || kept.count != parts.count {
    if kept.contains(where: { !sentenceHasFiniteVerb($0) }) { return (norm(s), true) }
  }
  return (kept.joined(separator: " "), dropped || kept.count != parts.count)
}
/// run 12 (Glidr's #48 Totluft): a back opening with a demonstrative ("Diese Luft wird daher auch Totluft genannt")
/// has no antecedent — the PREVIOUS sentence of the section is prepended so the card defines something
func pullPrevious(_ s: String, secText: String) -> (String, Bool) {
  let t = norm(s)
  guard startsWithDemonstrative(t) else { return (t, false) }
  let all = splitSentences(secText).map(norm)
  guard let i = all.firstIndex(where: { $0 == t || $0.hasPrefix(String(t.prefix(40))) }), i > 0 else { return (t, false) }
  // run 14 (#47): never twice — when the previous sentence already sits in the text (as a sentence), nothing is pulled in
  if splitSentences(t).dropFirst().contains(where: { contentOverlap($0, all[i - 1]) >= 0.7 }) || contentOverlap(all[i - 1], t) >= 0.9 { return (t, false) }
  return (all[i - 1] + " " + t, true)
}
/// run 14 (#39): the sentences of a back follow the SOURCE order — a pulled-in antecedent goes before, and a model that swapped
/// two source sentences is put right. Only when every back sentence is matched to a distinct source sentence (>= 60 % of its stems)
func orderBySource(_ back: String, secText: String) -> (String, Bool) {
  let bs = splitSentences(norm(back)).map(norm).filter { !$0.isEmpty }
  guard bs.count >= 2 else { return (norm(back), false) }
  let src = splitSentences(secText).map { restoreAbbr(norm($0)) }
  var idx: [Int] = []
  for b in bs {
    let sb = stems(b); guard !sb.isEmpty else { return (norm(back), false) }
    var best = (-1, 0.0)
    for (i, s) in src.enumerated() { let f = Double(sb.intersection(stems(s)).count) / Double(sb.count); if f > best.1 { best = (i, f) } }
    guard best.0 >= 0, best.1 >= 0.6 else { return (norm(back), false) }
    idx.append(best.0)
  }
  guard Set(idx).count == idx.count, idx != idx.sorted() else { return (norm(back), false) }
  return (zip(idx, bs).sorted { $0.0 < $1.0 }.map { $0.1 }.joined(separator: " "), true)
}
/// run 14 (#25/#29): a back whose "(" was cut ("(Stabilität, Gebirgshöhe aus.") gets its ")" from the source parenthesis; failing that
/// the dangling "(" is dropped — never an unbalanced bracket in an output text
func balanceParens(_ s: String, secText: String) -> (String, Bool) {
  let o = s.filter { $0 == "(" }.count, c = s.filter { $0 == ")" }.count
  guard o > c, let open = s.lastIndex(of: "(") else { return (s, false) }
  let frag = String(s[open...])
  let src = restoreAbbr(secText)
  let key = String(frag.prefix(14))
  if let r = src.range(of: key), let close = src[r.lowerBound...].firstIndex(of: ")") {
    let par = String(src[r.lowerBound...close])
    var k = 0; let fa = Array(frag), pa = Array(par)
    while k < fa.count && k < pa.count && fa[k] == pa[k] { k += 1 }
    if k >= 14 && k < pa.count && pa[k] == ")" {
      let head = String(s[..<open]); let fixed = head + String(fa[..<k]) + ")" + String(fa[k...])
      return (norm(fixed), true)
    }
  }
  return (norm(s.replacingOccurrences(of: "(", with: "", options: [], range: open..<s.index(after: open))), true)
}
/// run 14 (#63): a fact quote that starts right AFTER a sentence-initial conjunction ("Da", "Weil", "Wenn", "Obwohl") gets it back
func snapLeadingConj(_ q: String, secText: String) -> String {
  let t = restoreAbbr(norm(q)); guard t.count >= 20 else { return t }
  for s in splitSentences(secText).map({ restoreAbbr(norm($0)) }) {
    for c in ["Da","Weil","Wenn","Obwohl","Während","Sobald","Falls","Sofern","Nachdem","Bevor","Dass"] where s.hasPrefix(c + " ") && String(s.dropFirst(c.count + 1)).hasPrefix(String(t.prefix(30))) && !t.hasPrefix(c + " ") {
      return c + " " + t
    }
  }
  return t
}
/// run 14 (#3 Luv/Lee): a two-sentence quote whose sentences name OPPOSITE sides (Luv vs Lee) is split into its sentences
func splitOppositeSides(_ q: String) -> [String] {
  let ss = splitSentences(restoreAbbr(norm(q))).map(norm).filter { !$0.isEmpty }
  guard ss.count >= 2 else { return [norm(q)] }
  func side(_ s: String) -> Int { let l = s.lowercased(); let lu = l.contains("luv"), le = l.contains("lee"); return lu && !le ? 1 : (le && !lu ? 2 : 0) }
  let sides = ss.map(side)
  guard sides.contains(1) && sides.contains(2) else { return [norm(q)] }
  return ss
}
/// run 14 (#3): a back sentence on one side (Luv or Lee) that merges a source sentence of that side with a source sentence
/// about warming/drying/descending air (the other side's effects) — detected against the source sentences it is built from
func sideMerge(_ back: String, secText: String) -> Bool {
  let src = splitSentences(secText).map { restoreAbbr(norm($0)) }
  for b in splitSentences(norm(back)).map(norm) {
    let l = b.lowercased()
    guard l.contains("luv") && !l.contains("lee") else { continue }
    guard has(rx(#"erwärm|trockn|herabström|absink|föhn"#), b) else { continue }
    let sb = stems(b)
    let hits = src.filter { s in let ss = stems(s); return !ss.isEmpty && Double(ss.intersection(sb).count) / Double(ss.count) >= 0.35 }
    let luvOnly = hits.contains { $0.lowercased().contains("luv") && !has(rx(#"erwärm|trockn|herabström|absink"#), $0) }
    let effOnly = hits.contains { !$0.lowercased().contains("luv") && has(rx(#"erwärm|trockn|herabström|absink"#), $0) }
    if luvOnly && effOnly { return true }
  }
  return false
}

// ---- run 8 rules: precise named terms, indicator/condition cues, term survival, question fronts ----
/// abbreviation dots are §§-protected before matching too, so "sog." no longer breaks the "wird … genannt" zone or a sentence
func abbrProtect(_ s: String) -> String { var r = s; for d in abbrList { r = r.replacingOccurrences(of: d, with: d.replacingOccurrences(of: ".", with: "§§")) }; return r }
// run 10: "sog." matches its §§-protected form too (run 9's "sog\." never fired on protected text, so ¶20
// "dem sog. Rückseitenwetter" was missed); the "wird … genannt" zone allows only lower-case words (no verbs, no
// prepositions), so it captures the noun before "genannt" ("Totluft") and not a clause or "Luft"
// run 11: the "sog." cue matches its §§-protected form at word boundaries ("dem sog§§ Rückseitenwetter"); run 10's
// "sog[§§.]" was unanchored and ate letters inside words (…sogenannte -> matched "sog"), which broke the ¶74 zone
let namedTermRe = rx(#"(spricht man von|sogenannte[rns]?|\bsog(?:§§|\.)|nennt man|(?:so |es )?heißt(?:en)?\b|bezeichnet (?:man|er) (als|zu)|(?:wird|werden)\s(?:[a-zäöüß]+\s){1,4}[A-ZÄÖÜ][\wäöüß-]+\s+genannt)"#)
/// "X sind (ein sichtbares) Anzeichen/Merkmal/Zeichen für Y" — indicator cue; the term is X (before the cue), Y is kept in the sentence
let anzeichenRe = rx(#"\b(?:sind|ist|sei|waren)\b[^§§.]{0,40}?(?:ein[e]?)?\s*(?:sichtbares?|deutliches?|typisches?|unmittelbares?|wichtiges?)?\s*(Anzeichen|Anzeichen für|Merkmal[e]?|Kennzeichen|Zeichen|Hinweis[e]?)\s*(?:für|darauf)?"#)
/// condition cue: "überall dort, wo …", "wenn … trifft/auftrifft" — a condition statement, mandatory at the cap
// run 11: the old "überall dort,\s*wo" never matched the real ¶65 sentence — a comma directly after an ASCII letter
// matches NOTHING in this ICU build ("dort,\s*wo" -> 0 hits, "auftreten,\s*wo" -> 1), so the cue is written with \s*,
// which behaves correctly here. The old form stays as a fallback alternative.
// run 11: the old "überall dort,\s*wo" never matched the real ¶65 sentence — in this ICU build a comma directly after
// an ASCII letter matches nothing ("dort,\s*wo" -> 0 hits); with \s+ between the cue words it fires. Kept as a fallback.
let condWhereRe = rx(#"überall\s+dort\s+\S+,\s*wo\b|überall dort,\s*wo\b|\bwenn\b[^§§.]{0,80}?(?:trifft|auftrifft|traf|auftraf)"#)
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
/// run 11: an ADJ+NOUN capture is dictionary-formatted ("pulsierender Thermik" -> "pulsierende Thermik", Glidr's ¶10
//   expectation): the adjective takes the weak ending -e when it follows a definite article or a preposition with an
//   -em/-er dateline ("von pulsierender Thermik" — der is not in the capture, so the cue context decides); after an
//   uninflected "sogenannte(s)" the adjective keeps its strong ending (-er/-es), which is why this only applies to the
//   extractAfter path (the sog. branch never calls it)
func dictAdjNoun(_ t: String) -> String {
  let ws = t.split(separator: " ").map(String.init)
  guard ws.count == 2, has(adjCapPairRe, t) else { return t }
  let a = ws[0]
  // strong ending -er/-es/-em/-en -> weak -e ("pulsierender" -> "pulsierende", "stabiler" -> "stabile")
  for suf in ["er","es","em","en"] where a.hasSuffix(suf) && a.count - suf.count >= 3 {
    return String(a.dropLast()) + " " + ws[1]
  }
  return t
}
func extractAfter(_ s: String, after upper: String.Index) -> String {
  let zone = String(s[upper...])
  // run 11: a leading "adjective + Noun" is captured whole and dictionary-formatted ("von pulsierender Thermik")
  if let m = rxc(#"^[\s„"]*([a-zäöüß]+(?:en|em|er|es|e))\s+([A-ZÄÖÜ][\wäöüß-]+)"#).firstMatch(in: zone, range: NSRange(zone.startIndex..., in: zone)),
     let a = Range(m.range(at: 1), in: zone), let n = Range(m.range(at: 2), in: zone), !prepLower.contains(String(zone[a]).lowercased()), !stopLower.contains(String(zone[a]).lowercased()) {
    return dictAdjNoun(String(zone[a]) + " " + String(zone[n]))
  }
  guard let m = capRunRe.firstMatch(in: zone, range: NSRange(zone.startIndex..., in: zone)), let r = Range(m.range, in: zone) else { return "" }
  var t = norm(String(zone[r]))
  if let c = t.firstIndex(where: { $0 == "," || $0 == ";" }) { t = String(t[t.startIndex..<c]) }
  let ws = t.split(separator: " ")
  guard let h = ws.first else { return "" }
  let headClean = h.first.map { $0.isUppercase } ?? false
  if !headClean { return "" }   // run 11: capRunRe heads always start upper-case; run 10 required ALL upper-case and dropped every noun
  let trimmed = ws.count > 3 ? ws.prefix(3).joined(separator: " ") : t
  // a 2-word capture with an adjective head is dictionary-formatted ("pulsierender Thermik" -> "pulsierende Thermik");
  // a participle head keeps its wording (adjCapPairRe only admits true adjective endings, not "schießend")
  if ws.count == 2 && !headClean { return dictAdjNoun(trimmed) }
  return trimmed
}
/// run 10: a parenthesis whose INNER term is a technical compound ("(Föhnkrankheit)", "(labile Schichtung)") counts
/// even when the noun phrase before it is a generic word — run 9 rejected ¶5 because "Beschwerden" failed okTerm
let techSuffixRe = rxc(#"(?:krankheit|fenster|mauer|sturm|wolken|wolke|thermik|regen|luft|front|schichtung|druckgradient|druck)$"#)
/// generic nouns that name nothing specific: never a term even when capitalised (run 8 caught "Stelle")
let genericNouns: Set<String> = ["stelle","zeit","fall","art","weise","form","teil","bereich","ende","anfang","grund",
  "gedanke","rolle","bedeutung","ursache","wirkung","funktion","eigenschaft","seite","rand","fläche","masse","zustand","vorgang","beispiel",
  // run 12 (Glidr's "Ablösung tritt"): a process noun of this kind names no specific term either
  "ablösung","abkühlung","erwärmung","auslöser",
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
  // run 12 (Glidr's score): a formula capture is junk on EVERY path — the parenthesis path skipped junkTerm and
  // accepted "(τTh−τLu)" / "(ϑLu−τLu)"; two Greek letters or an operator chain never become a named term
  if has(formulaDebrisRe, tt) { return (true, "formula") }
  let h = String(tt.split(separator: " ").first ?? "").lowercased()
  // a bare single generic word is junk; a multi-word capture whose HEAD is generic may still be a term
  // ("schießend strömende Luft" — run 7's rotor hit — must survive looksLikeTerm, which owns the final check)
  if tt.split(separator: " ").count == 1 && genericNouns.contains(h) { return (true, "generic-word") }
  if has(yearRe, tt) { return (true, "year") }
  // run 11: the article's own topic words are never a named term ("Föhn", "Thermik" — Glidr's score); and a capture whose
  // HEAD is a generic noun or an article/function word is junk even with more words behind it ("Ablösung tritt",
  // "‚der Deutsche") — the junk filter must run AFTER capture, not only on bare single words
  let wsj = tt.split(separator: " ").map { $0.lowercased() }
  if wsj.count == 1 && (wsj[0] == "föhn" || wsj[0] == "thermik") { return (true, "topic-word") }
  // run 13 (Glidr's junk list): "Umgebung" (#85) names no term either — it joins the generic nouns as a bare word and its
  // head ("Ballonhülle zur Umgebung" already trims to it via trimTermTail's preposition rule)
  if wsj.count == 1 && wsj[0] == "umgebung" { return (true, "generic-word") }
  // run 13: a capture that still holds an INNER quote mark ("‚Fallwind‘" -> "‚Fallwind", #13) or a value description built on
  // an adjective ("kleiner Albedowert", #72 — "kleinster" too) names nothing; the trimmers only strip EDGE punctuation
  if tt.unicodeScalars.contains(where: { "\u{201A}\u{201B}\u{2019}\u{2018}\u{00AB}\u{00BB}\u{201C}\u{201D}".unicodeScalars.contains($0) }) { return (true, "quote-fragment") }
  if wsj.count >= 2 && ["klein","kleiner","kleines","kleinem","kleinen","kleinste","kleinster","groß","größer","hoher","hohes","hohem","hohen","niedriger","niedriges","niedrigem","niedrigen","geringer","geringes","geringem","geringen","hoch","lange","langer"].contains(wsj[0]) { return (true, "value-description") }
  // run 13 (#32/#33): a capture holding a FINITE VERB anywhere is a clause ("Wasser strömt langsamer", "Geschwindigkeit
  // strömendes"), never a term — trimTermTail only strips the tail verb; a participle inside a real term ("schießend
  // strömende Luft") holds no finite form and survives
  if wsj.count >= 2 && wsj.contains(where: { has(verbFormRe, $0) }) { return (true, "clause-verb") }
  // run 14 (#23 "Wasser strömt langsamer", #34 "Geschwindigkeit strömendes"): a term is a NOUN phrase — no lower-case finite verb
  // anywhere in it (lexicon or -t form), and a capitalised head must not END in a lower-case adjective/participle/adverb tail
  let tokRaw = tt.split(separator: " ").map(String.init)
  if tokRaw.count >= 2 {
    for (i, w) in tokRaw.enumerated() where i > 0 && (w.first?.isLowercase ?? false) {
      let l = w.lowercased()
      if finiteLexicon.contains(l) || (has(rx(#"^[a-zäöüß]{4,}(?:st|et|t)$"#), l) && !notVerbT.contains(l) && !l.hasSuffix("ent") && !l.hasSuffix("iert") && !l.hasPrefix("ge")) { return (true, "clause-verb") }
    }
    let first = tokRaw[0], last = tokRaw[tokRaw.count - 1]
    if (first.first?.isUppercase ?? false), (last.first?.isLowercase ?? false), has(rx(#"(?:er|es|en|em|e|end|ende|endes|enden|ender|endem)$"#), last), !has(rx(#"(?:is|us|um)$"#), last) { return (true, "np-tail") }
  }
  // run 12 (Glidr's #13): a bare German adjective used as a noun ("der Deutsche" -> head "deutsche") names nothing
  if wsj.count == 1 && has(rx(#"^deutsche[rnms]?$"#), wsj[0]) { return (true, "bare-adjective") }
  // run 12: the junk list from the parenthesis path — a single bare PERSON name ("Julius", "Bart"), an adjective used as
  // a bare noun ("der Deutsche" -> head "deutsche") and a verb form that slipped the regexes ("tritt"); these were the
  // accepted captures behind the bad fronts #13/#27 (Glidr's run-11 score)
  if wsj.count == 1 && (personNames.contains(wsj[0]) || bareAdjNouns.contains(wsj[0]) || has(verbRe, wsj[0])) { return (true, "name/adj/verb") }
  // a two-word capture whose HEAD is a lowercase article/preposition or a verb form is a clause, not a term ("der Deutsche")
  if wsj.count >= 2 && (["der","die","das","ein","eine","einen","dem","den","des"].contains(wsj[0]) || has(verbRe, wsj[0])) { return (true, "clause-head") }
  if wsj.count > 1 && (genericNouns.contains(wsj[0]) || stopLower.contains(wsj[0])) { return (true, "generic-head") }
  return nil
}
/// run 12: bare person names seen as junk captures in these sections ("wird gern thermodynamisch genannt" -> Julius)
let personNames: Set<String> = ["julius","bart","julia","caesar","cäsar","napoleon"]
/// run 12: an adjective used as a bare noun names nothing specific ("der Deutsche")
let bareAdjNouns: Set<String> = ["deutsche","deutscher","deutschen","fremdwort"]
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
  // run 12 (Glidr's "Ablösung tritt"): a finite verb form as the LAST word of a capture is a clause tail, not part of
  // the term — "Ablösung tritt" trims to "Ablösung", which junkTerm then rejects as a generic/verb word
  while ws.count > 1 && has(verbFormRe, ws[ws.count - 1].lowercased()) { ws.removeLast() }
  return ws.joined(separator: " ")
}
/// finite verb forms that may never end a term capture ("tritt", "findet", "wird", …)
let verbFormRe = rx(#"^(?:tritt|findet?|fände|gilt|gelte|macht|habe|hat|haben|ist|sind|sei|wird|werden|wurde|kam|kommt|geben|gibt|bildet|entsteht|liegt|beträgt|nennt|heißt|führt|rührt)$"#)
/// run 9 acceptance: a capitalised noun/compound or abbreviation >=4 chars, not pronoun/adverb, not a bare
/// sentence-initial word (unless the cue heads the sentence and introduces the term), not a generic noun, not a
/// verb form, not a place name. Returns (ok, reason, trimmed term).
func looksLikeTerm(_ raw: String, sentInitials: Set<String> = [], places: Set<String> = [], initialOk: Bool = false) -> (Bool, String, String) {
  let t0 = norm(raw).trimmingCharacters(in: CharacterSet(charactersIn: " „\"'“”‘’·.")).trimmingCharacters(in: .whitespaces)
  if t0.count < 4 { return (false, "short", t0) }
  let ws0 = t0.split(separator: " ").map(String.init)
  let hh = String(ws0[0].prefix(while: { $0 != "." })).lowercased()
  // run 11: the junk filter runs AFTER capture and after trimming — a multi-word capture whose HEAD is generic or
  // article-like is junk too ("Ablösung tritt", "‚der Deutsche"); only a term parenthesis bypasses it (the caller passes
  // the already-checked inner term), everything else goes through junkTerm here, not before the shape checks
  if !has(quotedTermRe, t0) || ws0.count > 1 {
    if let j = junkTerm(t0) { return (false, j.1, t0) }
  }
  if has(quotedTermRe, t0) && ws0.count == 1 { return (true, "ok", t0) }
  if notTermLower.contains(hh) || notTerm.contains(hh) { return (false, "pronoun/verb-list", t0) }
  if places.contains(t0.lowercased()) || places.contains(hh) { return (false, "place", t0) }
  if has(verbRe, hh) { return (false, "verb", t0) }
  if genericNouns.contains(hh) { return (false, "generic-noun", t0) }
  let t = trimTermTail(t0)
  if t.count < 4 { return (false, "short", t) }
  // run 11: the junk filter applies to the TRIMMED term too ("Ablösung tritt" -> "Ablösung" is a bare generic word)
  if let j = junkTerm(t) { return (false, j.1, t) }
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
/// run 11: trim a source sentence for an extractive bullet — parentheticals and their spaces removed, whitespace
/// collapsed; the words that remain are verbatim from the section (Glidr's only allowed map edit)
/// run 14 (Schichtung labels, Föhnkrankheit): a parenthesis that CONTAINS an accepted term is kept (`keep`: the accepted terms)
func trimParentheticals(_ s: String, keep: [String] = []) -> String {
  let re = try! NSRegularExpression(pattern: #"\s*\([^()]*\)\s*"#)
  var out = ""; var last = s.startIndex
  for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
    guard let r = Range(m.range, in: s) else { continue }
    out += s[last..<r.lowerBound]
    let piece = String(s[r])
    if keep.contains(where: { !$0.isEmpty && piece.lowercased().contains($0.lowercased()) }) { out += piece } else { out += " " }
    last = r.upperBound
  }
  out += s[last...]
  return norm(out).trimmingCharacters(in: CharacterSet(charactersIn: " „\"'“”‘’·,-"))
}
func pct(_ n: Int, _ d: Int) -> String { d == 0 ? "n/a" : "\(n)/\(d) (\(Int(Double(n) * 100 / Double(d)))%)" }

// ---- run 12 shared helpers (Glidr's run-11 score): stems, finite verbs, demonstratives, spacing, abbreviation restore ----
/// German inflection endings stripped for comparison (-es, -s, -er, -en, -e, -em; longest first so "Aufwinds" keeps its
/// stem). A word never shrinks below 4 letters ("Thermik" stays "thermik", "Wind" stays "wind").
func deStem(_ w: String) -> String {
  var s = w.lowercased()
  for suf in ["es", "em", "er", "en", "s", "e"] where s.hasSuffix(suf) && s.count - suf.count >= 4 { s = String(s.dropLast(suf.count)); break }
  return s
}
/// content words of a text as STEMS (run 12: every comparison that used to run on 5-char prefixes runs on these)
func stemWords(_ s: String) -> Set<String> { Set(words(s).map(deStem)) }
/// run 12 fix: is a lost-term candidate present in the back? numbers compare on their digit runs ("1,0 °C" vs "1 °C" and
/// "100 m" both keep "100"), words on stems, hyphen compounds piece by piece; units alone never count as lost
func termKept(_ t: String, back: String, backStems: Set<String>) -> Bool {
  let b = restoreAbbr(back).lowercased()
  if t.first?.isNumber ?? false {
    let nums = t.components(separatedBy: CharacterSet(charactersIn: "0123456789,.").inverted).filter { $0.contains(where: { $0.isNumber }) }
    let lead = nums.first.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ",.")) } ?? ""
    if lead.isEmpty { return true }
    let alt = lead.replacingOccurrences(of: ",", with: ".")
    return b.contains(lead) || b.replacingOccurrences(of: ",", with: ".").contains(alt) || (lead.hasSuffix(",0") && b.contains(String(lead.dropLast(2))))
  }
  let pieces = t.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count >= 3 }
  return pieces.allSatisfy { w in backStems.contains(deStem(w)) || backStems.contains(w) || b.contains(String(w.prefix(max(4, w.count - 3)))) }
}
/// the §§ abbreviation placeholder restored ("engl§§" -> "engl."); every term and output text passes through this
func restoreAbbr(_ s: String) -> String { norm(s.replacingOccurrences(of: "§§ ", with: ". ").replacingOccurrences(of: "§§", with: ".")) }
/// a German finite verb in 2nd/3rd person (bare infinitives like "abkühlen" are excluded; "abkühlt" is caught by -t):
/// the grammar test for summaries ("spricht", "führt", "wird", "tritt", "kühlt")
let finiteVerbRe = rx(#"\b(?:ist|sind|sei|seien|war|waren|wurde|wurden|hat|haben|hatte|hatten|wird|werden|kann|können|muss|müssen|darf|soll|will|rührt|führt|spricht|tritt|bildet|entsteht|besteht|bedeutet|nennt|heißt|liegt|beträgt|erreicht|nimmt|gibt|macht|bringt|zeigt|wirkt|steigt|sinkt|fällt|hält|bleibt|wächst)\b|\b[a-zäöüß]{3,}(?:st|et|t)\b"#)
/// run 14 finite-verb check (Glidr's #10 #22 #51 false positives, #11 #52 #37 misses): token based, MAIN clauses only.
/// A lexicon of common finite forms (aux/modals, preterites, plural presents like "treten"), a -t ending on a lower-case word
/// (not a participle at the end of the main clause), a prefix verb in -en that is not the last word, and a separable-prefix
/// particle closing the clause ("… ging … ein", "treten … auf"). Subordinate clauses (der/die/das/dass/weil/wenn/…) and
/// parentheses are ignored, so a verb inside a relative clause does not make a fragment a sentence.
let finiteLexicon: Set<String> = ["ist","sind","sei","seien","war","waren","wurde","wurden","wird","werden","hat","haben","hatte","hatten","kann","können","konnte","konnten","muss","müssen","musste","darf","dürfen","soll","sollen","will","wollen","mag","ging","gehen","geht","kam","kommen","kommt","gab","gibt","fand","finden","findet","stand","stehen","steht","lag","liegen","liegt","blieb","bleiben","bleibt","trat","treten","tritt","entstehen","entsteht","entstand","entstanden","bilden","bildet","fließen","fließt","strömen","strömt","steigen","steigt","sinken","sinkt","fallen","fällt","wehen","weht","wirken","wirkt","zeigen","zeigt","gelten","gilt","nennen","nennt","heißt","heißen","hängen","hängt","führen","führt","entsprechen","entspricht","beginnen","beginnt","enden","endet","sprechen","spricht","besteht","bestehen","beträgt","betragen","bedeutet","bedeuten","erreichen","erreicht","erwärmt","erwärmen","kühlt","kühlen","bewegen","bewegt","tun","tut","lässt","lassen","verhält","verhalten","verlaufen","verläuft","erfolgt","erfolgen","herrschen","herrscht","existieren","existiert","bringt","bringen","macht","machen","nimmt","nehmen","dringt","dringen","stellt","stellen","sieht","sehen","setzt","setzen","hält","halten","wächst","wachsen","erklärt","erklären","erzeugt","erzeugen","verursacht","verursachen","ermöglicht","ermöglichen","beeinflusst","beeinflussen","überströmen","überströmt","abregnen","regnet","kondensiert","verdunstet","gelangen","gelangt","reichen","reicht","dauern","dauert","tragen","trägt","folgen","folgt","gehören","gehört","sinkt","verschwindet","gerät","geraten","kennen","kennt"]
let separableParticles: Set<String> = ["ein","auf","ab","an","aus","vor","mit","nach","zu","um","her","hin","weg","fort","zurück","vorbei","dar","los","fest","zusammen","hinzu","hinweg","hinab","hinauf","herab","heraus","hinein","herein"]
let subordinators: Set<String> = ["der","die","das","dem","den","dessen","deren","welche","welcher","welches","welchem","welchen","dass","daß","weil","da","wenn","obwohl","ob","sodass","sobald","soweit","solange","bis","während","nachdem","bevor","falls","sofern","indem","damit","wobei","wodurch","worauf","womit","wo","sowie"]
let notVerbT: Set<String> = ["nicht","mit","bereits","zunächst","oft","weit","kalt","alt","laut","dort","statt","samt","seit","meist","erst","zuerst","höchst","stets","zuletzt","jetzt","nachts","tagsüber","trotzdem","jedoch","sondern","bergwärts","ebenso","allerdings","wohl","bald","fast","kurzzeitig","zusätzlich","ständig","typischerweise","vorwiegend","besonders","hauptsächlich","gleichzeitig","durchgehend","aufgrund","abhängig","hierbei","daraufhin","bestimmt","gesamt","jeweils","wenig","nämlich","unterhalb","oberhalb","innerhalb","außerhalb","zumeist","angeblich"]
func lcTokens(_ s: String) -> [String] {
  var r = abbrProtect(s).replacingOccurrences(of: #"\([^()]*\)"#, with: " ", options: .regularExpression)
  r = r.replacingOccurrences(of: "§§", with: ".")
  return r.replacingOccurrences(of: #"[„“"'‚‘’”»«]"#, with: " ", options: .regularExpression)
    .components(separatedBy: CharacterSet.whitespacesAndNewlines).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".!?;:–—")) }.filter { !$0.isEmpty }
}
func mainClauseTokens(_ s: String) -> [String] {
  let t = lcTokens(s).joined(separator: " ")
  let conj: Set<String> = ["dass","daß","weil","da","wenn","obwohl","ob","sodass","sobald","soweit","solange","bis","während","nachdem","bevor","falls","sofern","indem","wobei","wodurch","worauf","womit","wo","sowie"]
  var kept: [String] = []
  for (ci, cl) in t.components(separatedBy: ", ").enumerated() {
    let toks = cl.split(separator: " ").map(String.init)
    guard let f = toks.first else { continue }
    let fl = f.lowercased()
    // a clause opening with a subordinating conjunction is subordinate; a LOWER-CASE article/relative pronoun opens a relative clause
    // after a comma (a capitalised "Die" starting the sentence is a main-clause article and stays)
    // "während des/dieses …" is the PREPOSITION (genitive), not the conjunction
    if conj.contains(fl) && !(fl == "während" && toks.count > 1 && ["des","dieses","dieser","eines","der"].contains(toks[1].lowercased())) { continue }
    if ci > 0 && subordinators.contains(f) { continue }
    // a later clause that ENDS in its finite verb (>= 5 words) is verb-final = subordinate (the tail of an interrupted relative clause)
    if ci > 0 && toks.count >= 5, let lt = toks.last, lt.first?.isLowercase ?? false, finiteLexicon.contains(lt) { continue }
    kept.append(contentsOf: toks)
  }
  return kept
}
func sentenceHasFiniteVerb(_ s: String) -> Bool {
  let toks = mainClauseTokens(s)
  guard !toks.isEmpty else { return false }
  let n = toks.count
  for (i, tk) in toks.enumerated() {
    let l = tk.lowercased()
    let lowerInit = tk.first.map { $0.isLowercase } ?? false
    if finiteLexicon.contains(l) && (lowerInit || i == 0) { return true }
    guard lowerInit, l.count >= 4 else { continue }
    if notVerbT.contains(l) { continue }
    // -t / -st / -et on a lower-case word: finite, unless it is a participle closing a long main clause ("… charakterisiert")
    if has(rx(#"^[a-zäöüß]{3,}(?:st|et|t)$"#), l) {
      if i == n - 1 && n >= 5 { continue }
      if l.count >= 7 && has(rx(#"^(?:ab|an|auf|aus|ein|mit|nach|vor|zu|her|hin|um|durch)?ge[a-zäöüß]{2,}t$"#), l) && !finiteLexicon.contains(l) { continue }
      return true
    }
    // a prefix verb in -en that is not the last word of the clause (plural present: "Dabei entstehen Wirbel")
    if i < n - 1 && l.hasSuffix("en") && has(verbRe, l) { return true }
    // a plural present right before an article/pronoun/preposition ("Sperrschichten … stoppen die …", "gleichen die …", "resultieren aus …")
    if i >= 1 && i < n - 1 && l.count >= 6 && l.hasSuffix("en") && !stopLower.contains(l) && !prepLower.contains(l) && !["neben","oben","unten","innen","außen","eben","wegen","gegen","zwischen","trotzen"].contains(l),
       ["die","das","den","dem","der","ein","eine","einen","sich","sie","es","diese","dieses","aus","in","auf","an","bei","mit","durch","über","unter","für","zu","nach","vor","von"].contains(toks[i + 1].lowercased()) { return true }
  }
  // a separable particle closing the clause next to some lower-case verb-like word ("ging … ein", "wehen … auf")
  if let last = toks.last?.lowercased(), separableParticles.contains(last), n >= 4,
     toks.dropLast().contains(where: { w in (w.first?.isLowercase ?? false) && w.count >= 5 && (w.hasSuffix("en") || w.hasSuffix("t") || w.hasSuffix("et") || w.hasSuffix("e")) && !separableParticles.contains(w.lowercased()) && !stopLower.contains(w.lowercased()) }) { return true }
  return false
}
/// a front asks with a finite verb: 2nd/3rd person only (the loose -en/-e tail would accept any infinitive)
let frontVerbRe = rx(#"\b(?:ist|sind|sei|war|waren|wurde|wurden|hat|hatte|hatten|wird|werden|kann|können|muss|müssen|darf|soll|will|rührt|führt|spricht|tritt|bildet|entsteht|besteht|bedeutet|nennt|heißt|liegt|beträgt|erreicht|nimmt|gibt|macht|bringt|zeigt|wirkt|steigt|sinkt|hält|bleibt|wächst)\b|\b[a-zäöüß]{3,}(?:st|et|t)\b"#)
/// a German question inverts verb-first ("Entsteht der Föhn …?"), so both orders are accepted; "Was/Wie… ist" is the
/// copula and does NOT count as an asking verb (Glidr's #12/#13: "Was ist die Bezeichnung Föhn?" has no real verb)
func frontHasFiniteVerb(_ s: String) -> Bool {
  let prot = abbrProtect(s)
  // run 12 fix: a W-question's second word is the finite verb when it is lowercase and no article/preposition/copula
  // ("Wie treten Mountain waves auf?", "Wie entstand …", "Was spüren …") — the -st/-et/-t regex missed plural -en forms
  let wsO = norm(prot).components(separatedBy: " ")
  if wsO.count >= 3, ["was","wie","wo","wodurch","womit","warum","weshalb","wann","woher","woraus","wozu"].contains(wsO[0].lowercased()),
     let f1 = wsO[1].first, f1.isLowercase, wsO[1].count >= 4,
     !["der","die","das","dem","den","des","ein","eine","einer","einem","einen","ist","sind","sich","durch","bei","von","für","mit","aus"].contains(wsO[1]) { return true }
  if !has(frontVerbRe, prot) { return false }
  // the asking verb of a German W-question sits in second position; when that slot holds only the copula ("ist"),
  // the front has no real verb — "Was ist die Bezeichnung Föhn?" (Glidr #12/#13)
  let ws0 = norm(prot).lowercased().components(separatedBy: " ")
  guard ws0.count >= 2, let w0 = ws0.first, ["was","wie","wo","welche","welcher","welches","wodurch","womit","warum","weshalb","wann","woher","woraus"].contains(w0) else { return true }
  return !(ws0[1] == "ist" || ws0[1] == "sind")
}
/// a sentence/bullet opening with a demonstrative or anaphoric adverb: its antecedent is the PREVIOUS sentence
let demoStartRe = rx(#"^(Diese[rnms]?|Dieses|Dies|Solche[rnms]?|Das\s+führt|Damit|Daher|Deshalb|Dadurch|Hierbei|Sie|Er|Es|Man)\b"#)
func startsWithDemonstrative(_ s: String) -> Bool { has(demoStartRe, norm(s)) }
/// " ," / " ." debris left by removed parentheticals collapsed
func cleanSpacing(_ s: String) -> String {
  norm(s).replacingOccurrences(of: " ,", with: ",").replacingOccurrences(of: " .", with: ".")
    .replacingOccurrences(of: " :", with: ":").replacingOccurrences(of: " ;", with: ";")
}
/// run 12 test helper: the exact spacing of a string (norm() collapses spaces, which would hide the debris)
func spacingOf(_ s: String) -> String { s.replacingOccurrences(of: " ", with: "_") }
/// a front whose article or "Zahl" refers to something the question never names (Glidr #12/#26): "die Bezeichnung Föhn",
/// "die Zahl für die Strömung" — a definite article + noun that is NOT the sentence's own subject complement
let danglingAntecedentRe = rx(#"\bdie\s+(Bezeichnung|Zahl|Beschreibung|Definition|Angabe|Größe|Zustand)\b|\bder\s+(Begriff|Name|Föhnkühler)\b"#)
func hasFrontDanglingAntecedent(_ f: String) -> Bool {
  // run 12: ICU treats the \b after a non-ASCII letter as an optional boundary, so "die Zahl" matches inside
  // "BedeutUNG der Zahl" — test each word slot separately instead of relying on that anchor
  let ws0 = norm(f).lowercased().components(separatedBy: " ")
  // run 12 fix after the first full run (18/93): a noun is only dangling when NOTHING names its referent after it —
  // "die Zahl F", "die Bezeichnung Föhn" and "die Zahl für die Strömung" all name their subject; a bare final noun
  // ("Was bedeutet die Zahl?") does not. The next slot must be a real word, not punctuation or a modifier
  for i in 0..<ws0.count where (ws0[i] == "die" || ws0[i] == "der") {
    guard i + 1 < ws0.count else { continue }
    let nxt = ws0[i + 1].trimmingCharacters(in: CharacterSet(charactersIn: "?!,"))
    guard ["bezeichnung","zahl","beschreibung","definition","angabe","größe","zustand","begriff","name","föhnkühler"].contains(nxt) else { continue }
    // the slot after the noun names the referent unless it is empty, punctuation or a modifier ("für", "von") —
    // "die Zahl F" / "die Bezeichnung Föhn" are fine; "Was bedeutet die Zahl?" is not
    let next = i + 2 < ws0.count ? ws0[i + 2].trimmingCharacters(in: CharacterSet(charactersIn: "?!,")) : ""
    if !next.isEmpty && !["und","oder","aber"].contains(next) { continue }   // a name OR a modifier ("für …") follows
    return true
  }
  // "Was ist die Bezeichnung für X?" names what is named: fine; a bare noun stands for the section's word — reject
  if has(rx(#"\bdie\s+(Bezeichnung|Zahl)\s+(für|von)\b"#), f) { return false }
  return false
}
/// run 12 (Glidr's #13): a front that asks with "Was ist …?" but whose answer is a TERM (not a process, cause or
/// definition sentence — no finite verb beyond "ist") usually names its subject vaguely ("der deutsche
/// Fremdwort-Begriff"); such fronts are rejected so the model re-asks explicitly
func frontVagueSubject(_ f: String) -> Bool {
  // run 12 fix: the old drop(while: !isLetter) dropped EVERYTHING for a front starting with an umlaut ("Österreich…",
  // isLetter == true), and the later dropLast(2) crashed on short fronts — match the question opener instead
  let body = norm(f).lowercased()
  guard body.hasPrefix("was ist ") || body.hasPrefix("was sind ") else { return false }
  let rest = body.replacingOccurrences(of: "was ist ", with: "").replacingOccurrences(of: "was sind ", with: "")
  // vague when the subject is a bare article-noun chain without any genitive/of-phrase naming it ("der deutsche fremdwort-begriff");
  // run 12 fix: the '?' sits on the LAST WORD, so drop it before the shape test (the old "\??$" never matched)
  let restClean = rest.hasSuffix("?") ? String(rest.dropLast()) : rest
  return has(rx(#"^(der|die|das|ein|eine) [a-zäöüß-]+( [a-zäöüß-]+){0,3}$"#), restClean) && !has(rx(#"\b(von|für|des)\s+[a-zäöüß]"#), restClean)
}
func flagKey(_ f: String) -> String { f.split(separator: ":").first.map(String.init) ?? f }
/// stem of a German content word (>=4 letters, lowercased): plural/inflection-insensitive comparison
func stems4(_ s: String) -> Set<String> { Set(words(s).map { String($0.prefix(4)) }) }
/// named-term coverage of accepted cards: the term itself or >=2 shared content-word stems with its sentence
func termCovered(_ term: String, sent: String, front: String, back: String) -> Bool {
  let t = norm(term).lowercased()
  if !t.isEmpty && (norm(front + " " + back).lowercased().contains(t) || norm(front + " " + back).lowercased().contains(String(t.prefix(4)))) { return true }
  // run 12: STEMS instead of 4-char prefixes ("pulsierender Thermik" now covers the term "pulsierende Thermik")
  let ts = stemWords(sent)
  let fb = stemWords(front + " " + back).subtracting(qWordList.map(deStem))
  return ts.count >= 2 && ts.intersection(fb).count >= 2
}
/// run 12: a NOUN in German text (capitalised, >=4 letters, not mid-sentence verb-shaped) — the answerWordsMissing check
/// only counts nouns and numbers now; verbs and function words the model legitimately adds are ignored
func nounTokens(_ s: String) -> Set<String> {
  var out = Set<String>()
  // run 12 fix: do NOT match on abbrProtect(s) — §§ replaces "." with the 2-char placeholder and GROWS the string, so a
  // UTF-8 range of the protected text is invalid in `s` (this crashed card #11). Match on `s` itself; §§ words cannot
  // match [A-ZÄÖÜ][\wäöüß-]{3,} anyway (§ is not a word char), so abbreviations are simply skipped as noun tokens
  for m in rxc(#"\b[A-ZÄÖÜ][\wäöüß-]{3,}"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
    guard let r = Range(m.range, in: s) else { continue }
    let w = String(s[r])
    if stopLower.contains(w.lowercased()) || sentenceStartCaps.contains(w) { continue }
    out.insert(deStem(w))
  }
  for m in rx(#"\d+(?:[.,]\d+)?"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
    guard let r = Range(m.range, in: s) else { continue }
    out.insert(String(s[r]))   // numbers compared verbatim (0,6 stays 0,6)
  }
  return out
}

// ---- run 13 helpers (Glidr's run-12 score): term fronts, list tails, mismatch, per-sentence verbs, typo restore, quote demonstratives ----
/// the content nouns of a text as STEMS: capitalised words >=4 letters, not sentence-initial, not a stopword or verb form
/// (the same shape rule as techTerms) — the front/back mismatch check compares these
func contentNounStems(_ s: String) -> Set<String> {
  var out = Set<String>()
  for m in rxc(#"\b[A-ZÄÖÜ][a-zäöüß-]{3,}"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
    guard let r = Range(m.range, in: s) else { continue }
    let w = String(s[r])
    let pre = s[..<r.lowerBound].trimmingCharacters(in: .whitespaces)
    if pre.isEmpty || pre.hasSuffix(".") || pre.hasSuffix("!") || pre.hasSuffix("?") || pre.hasSuffix(":") { continue }
    if stopLower.contains(w.lowercased()) || sentenceStartCaps.contains(w) || has(verbRe, w.lowercased()) { continue }
    out.insert(deStem(w))
  }
  return out
}
/// run 13 (Glidr's #87): a back that ends in a comma-run of LOWERCASE words is a keyword list appended by an answer-repair —
/// matcher text must never reach the output. The tail and its commas are stripped ("…, thermik, umgebungsluft, dichteunterschiede, höhe.")
func stripListTail(_ s: String) -> (String, Bool) {
  let t = norm(s)
  guard let m = rx(#"(?:\s*,\s*[a-zäöüß][\wäöüß-]{2,}){2,}\s*[.!?]?\s*$"#).firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) else { return (t, false) }
  guard let cut = Range(m.range, in: t) else { return (t, false) }
  let head = String(t[..<cut.lowerBound]).trimmingCharacters(in: CharacterSet(charactersIn: " ,;"))
  guard head.split(separator: " ").count >= 3 else { return (t, false) }   // never gut a short back
  return (head + ".", true)
}
/// run 13 (Glidr's #8/#10/#3): the front's content nouns must appear in the BACK or in the FACT QUOTE — #8 (Südföhn) and #10
/// (Nordföhn) copied #3's "Wie verhält sich X durch feuchtadiabatisch … nach dem Gebirge?" template into their fronts while
/// neither word sits in their back; a front whose nouns all sit in the quote is fine (#78 asks Rückseitenwetter, the quote names it)
func frontBackMismatch(_ f: String, back: String, quote: String) -> Bool {
  let fn = contentNounStems(f)
  guard fn.count >= 2 else { return false }              // a short front ("Was ist X?") has nothing to check
  // run 14 (#12 "Lee-Seite" vs "Lee-", #26): hyphen compounds are compared piece by piece AND against the plain lower-cased
  // text, and a stem counts as present on a shared >=5-letter prefix ("temperatur" ~ "temperaturen")
  let have = stems(back).union(stems(quote))
  let plain = (back + " " + quote).lowercased().replacingOccurrences(of: "-", with: "")
  return !fn.allSatisfy { n in
    let nn = n.replacingOccurrences(of: "-", with: "")
    return have.contains(n) || plain.contains(nn) || have.contains(where: { h in h.count >= 5 && nn.count >= 5 && h.prefix(5) == nn.prefix(5) })
  }
}
/// run 13 (Glidr's #52/#54/#81): EVERY sentence of the back needs a finite verb — run 12 only checked after trimming, so a
/// pulled-in or concatenated fragment ("Albföhn der Schwäbischen Alb bei Südostwinden.") slipped through
func backSentenceFragments(_ back: String) -> [String] {
  splitSentences(norm(back)).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && !sentenceHasFiniteVerb($0) }
}
/// run 13 (Glidr's #18 "abgeregierte", 4th run): a back word that is neither verbatim in the fact quote nor anywhere in the
/// section is restored when it differs from EXACTLY ONE source word by at most TWO edits (substitute/insert/delete, >=7
/// letters — "abgeregierte" vs "abgeregnete" is substitute+delete; a distance-2 pair with a shared prefix of >=6 letters
/// ("abgere…") is unambiguous); ambiguous or far words stay and the card gets rejected instead
func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
  if a.isEmpty { return b.count }
  var prev = Array(0...b.count), cur = [Int](repeating: 0, count: b.count + 1)
  for i in 1...a.count {
    cur[0] = i
    for j in 1...b.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)) }
    prev = cur
  }
  return prev[b.count]
}
/// run 14 (#48 "der strömende Luft", #4, #14, #28): only a word that is OUT OF VOCABULARY (in NO section of the run — `vocab`) is
/// restored, and never to an inflection of the same stem ("strömenden" -> "strömende", "erreicht" -> "erreichen" stay as written)
func sameStemWord(_ a: String, _ b: String) -> Bool {
  let ca = Array(a), cb = Array(b); var k = 0
  while k < ca.count && k < cb.count && ca[k] == cb[k] { k += 1 }
  return k >= max(5, min(ca.count, cb.count) - 3)
}
func restoreTypos(_ back: String, quote: String, secText: String, vocab: Set<String>? = nil) -> (String, [String]) {
  var out = norm(back); var fixed: [String] = []
  let qw = words(canonV(quote)), sw = Set(words(canonV(secText)))
  for w in Set(words(canonV(out))) where w.count >= 7 {
    if qw.contains(w) || sw.contains(w) || (vocab?.contains(w) ?? false) { continue }
    // candidates: <=2 edits away, and either at distance 1 or sharing a >=6-letter prefix with the bad word — that shared
    // stem ("abgere…") is what makes a distance-2 restore safe; an ambiguous candidate set rejects instead of guessing
    let near = sw.filter { c in
      guard c.count >= 7, levenshtein(Array(w), Array(c)) <= 2, !sameStemWord(w, c) else { return false }
      if levenshtein(Array(w), Array(c)) == 1 { return true }
      let pc = String(c.prefix(6)), pw = String(w.prefix(6))
      return pc == pw && c != w
    }
    guard near.count == 1, let src = near.first else { continue }
    out = out.replacingOccurrences(of: w, with: src)
    fixed.append("\(w)->\(src)")
  }
  return (out, fixed)
}
/// run 13 (Glidr's #48): a fact quote opening with "Diese/dieser/solche + noun" has no antecedent for the model — the previous
/// source sentence is prepended to the QUOTE before the back is written, so the model sees what "Diese Leewellen" are
func pullQuoteAntecedent(_ q: String, secText: String) -> (String, Bool) {
  let t = restoreAbbr(norm(q))
  guard has(rx(#"^(Diese[rnms]?|Dieses|Solche[rnms]?)\s+[A-ZÄÖÜ]"#), t) else { return (t, false) }
  let all = splitSentences(secText).map { restoreAbbr(norm($0)) }
  guard let i = all.firstIndex(where: { $0 == t || $0.hasPrefix(String(t.prefix(40))) }), i > 0 else { return (t, false) }
  return (all[i - 1] + " " + t, true)
}
/// run 13 fix 1: the front of a TERM card is built in code — "Was ist <Term>?" (plural takes "sind"); a term whose words are all
/// lowercase gets the "Was versteht man unter …?" form so it opens with a W-word
func termFront(_ term: String) -> String {
  let t = restoreAbbr(norm(term)).trimmingCharacters(in: CharacterSet(charactersIn: " „\"'‘’·.,"))
  if t.isEmpty { return "" }
  // run 14 (#41 dative, "Was sind Steigungsregen?"): ALWAYS "Was ist <Term>?" — no "unter …" (needs the dative), never "sind"
  return "Was ist \(t)?"
}
/// run 14 item 7: the term of a term card must survive the junk filter and be a noun phrase BEFORE the template is applied
func termIsJunk(_ term: String) -> Bool {
  let t = restoreAbbr(norm(term))
  if t.isEmpty { return true }
  if junkTerm(t) != nil { return true }
  return false
}

/// run 14: every word (>= 4 letters, lower-cased) of EVERY section of the run — the typo restore only touches words outside it
nonisolated(unsafe) var globalVocab: Set<String> = []

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

/// named-term hits of a paragraph with accept/reject reason. The sentence is matched in §§-protected form so "sog."
/// and "z. B." neither split the sentence nor cut the match zone; positions map back 1:1 (§§ replaces "." only).
/// A term is accepted only if looksLikeTerm holds and it is not a place name ("in X" of the text) or junk.
/// run 11 PURE function: takes the paragraph TEXT (not a Para struct) so the --selftest unit test can call it directly.
/// run 11: NO one-hit-per-sentence cap — every cue match and every term parenthesis yields its own hit, in order
/// ("…Cumuluswolken sind ein sichtbares Anzeichen… spricht man von Blauthermik…" keeps BOTH terms; ¶19 keeps all three
/// "(stabile/indifferente/labile Schichtung)"). Junk is filtered after capture, so junk hits simply drop out.
func namedTermSentences(_ text: String, places: Set<String>) -> [(term: String, sent: String, cue: String, accepted: Bool, reason: String)] {
  var out: [(String, String, String, Bool, String)] = []
  // sentence-initial words of this paragraph: a single-word capture that opens its own sentence is the topic, not
  // the named term (run 8's "Heute"); an indicator cue heading the sentence is the exception (Cumuluswolken)
  var initials = Set<String>()
  let ptext = abbrProtect(text)   // run 11: split the PROTECTED text — "sog. Rückseitenwetter" must stay one sentence
  for sent in splitSentences(ptext) { if let m = rxc("^\\s*[A-ZÄÖÜ][\\wäöüß-]*").firstMatch(in: sent, range: NSRange(sent.startIndex..., in: sent)), let rg = Range(m.range, in: sent) { initials.insert(norm(String(sent[rg]))) } }
  // run 13 fix 5 (Glidr's #31, third run with it): "engl." is stripped from a capture AT CAPTURE — the term becomes
  // "hydraulic jump", so termsLost compares against a dot-free term ("engl. hydraulic jump" made the stem match split at
  // the "." and the card was dropped for a term its back contains literally); the junk filter runs on the STRIPPED form too,
  // so a capture that is only "engl." dies as empty; place names are checked on both forms ("in Freiburg")
  func okTerm(_ t: String, initialOk: Bool = false) -> (Bool, String, String) {
    let s0 = norm(t)
    let stripped = s0.hasPrefix("engl.") ? String(s0.dropFirst("engl.".count)).trimmingCharacters(in: .whitespaces) : s0
    var (ok, why, term) = looksLikeTerm(stripped, sentInitials: initials, places: places, initialOk: initialOk)
    if ok && !places.contains(norm(term).lowercased()) { return (true, why, term) }
    if stripped != s0 { return looksLikeTerm(s0, sentInitials: initials, places: places, initialOk: initialOk) }
    return (ok, why, term)
  }
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
  for raw in splitSentences(ptext) {
    let s0 = raw.replacingOccurrences(of: "§§", with: ".").trimmingCharacters(in: .whitespaces)
    if s0.isEmpty { continue }
    let s = abbrProtect(s0)
    var hitsHere: [(cue: String, term: String)] = []   // run 11: all cue hits of this sentence (no cap)
    var rejectReason = ""
    // one hit per pattern type; "das heißt"/"d. h." excluded ("das" is not a definition cue)
    for m in namedTermRe.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
      guard let r = Range(m.range, in: s) else { continue }
      let pat = String(s[r]).lowercased()
      if pat.hasSuffix("heißt") || pat.hasSuffix("heisst") || pat.hasSuffix("heißen") || pat.hasSuffix("heiße") {
        let pre = String(s[s.startIndex..<r.lowerBound]).trimmingCharacters(in: .whitespaces).lowercased()
        // run 14 (#23): the pre-text is TRIMMED, so "(das heißt, …" ends in "(das" — the old suffix tests needed a trailing space
        if pre.hasSuffix("das ") || pre.hasSuffix("d§§ h ") || pre.hasSuffix("d.§§h.") || pre == "das" || pre.hasSuffix(" das") || pre.hasSuffix("(das") || pre.hasSuffix("d§§ h") || pre.hasSuffix("d. h.") { continue }
      }
      let zb = zoneBefore(s, r.lowerBound)
      var cands: [String] = []
      if pat.hasSuffix("genannt") {
        // run 10: nearestCapBefore only sees the zone since the last comma — in "Diese Luft wird daher auch Totluft
        // genannt" that zone is "Diese Luft " and it grabs "Luft"; when the cue itself contains "wird/werden" the term
        // sits INSIDE the span, directly before "genannt" ("Totluft")
        // match against the RAW span (pat is lowercased for the branch tests; "Totluft" only survives there)
        let rawSpan = String(s[r])
        let cueCap = rxc("([A-ZÄÖÜ][\\wäöüß-]+)\\s+genannt$").firstMatch(in: rawSpan, range: NSRange(rawSpan.startIndex..., in: rawSpan)).flatMap { m2 -> String? in
          Range(m2.range(at: 1), in: rawSpan).map { norm(String(rawSpan[$0])) }
        } ?? ""
        cands = [cueCap, nearestCapBefore(zb), extractBefore(s, before: r.lowerBound), extractAfter(s, after: r.upperBound)]
      } else if pat.hasPrefix("sogenannte") || pat.hasPrefix("sog§§") || pat.hasPrefix("sog.") {
        // run 10: the §§-protected "sog." cue reaches this branch now (run 9's hasPrefix("sog.") never matched it)
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
      // run 13 fix 10: the logged cue passes through restoreAbbr — run 12 showed "sog§§" as the cue of Rückseitenwetter
      if !t.isEmpty { hitsHere.append((restoreAbbr(String(s[r])), t)) }   // run 11: keep going, no break — every cue hit counts (¶8)
      // remember the first non-empty capture's rejection reason for the log
      if rejectReason.isEmpty {
        for c in cands where !c.isEmpty { let (_, why, _) = okTerm(c); rejectReason = "reject:" + why; break }
      }
    }
    // indicator cue: "X sind ein (sichtbares) Anzeichen für Y" — the term is X before the verb and may head its sentence
    if let m = anzeichenRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range, in: s) {
      let t = pick([extractBefore(s, before: r.lowerBound)], initialOk: true)
      if !t.isEmpty && !hitsHere.contains(where: { $0.term.lowercased() == t.lowercased() }) { hitsHere.append((restoreAbbr(String(s[r])), t)) }   // run 13: cue restored too (no §§ leak in the log)
    }
    // run 14 (#44 ¶58, ¶64): a DASH appositive "– die Föhnmauer –" and a technical-compound appositive ", dem Föhnfenster" /
    // ", den Föhnlinsen" name a term too (the sentence NAMES it)
    for m in rxc(#"[–—]\s+(?:die|der|das|den|dem)\s+([A-ZÄÖÜ][\wäöüß-]{3,})\s+[–—]|,\s+(?:den|dem|die|der|das)\s+([A-ZÄÖÜ][\wäöüß]*(?:linsen|linse|fenster|mauer|sturm|krankheit|wolken|wolke))\b"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
      for g in 1...2 { if let rr = Range(m.range(at: g), in: s) { let t = norm(String(s[rr])); if !t.isEmpty && !hitsHere.contains(where: { $0.term.lowercased() == t.lowercased() }) { hitsHere.append(("– die \(t) –", t)) } } }
    }
    // condition cue: "überall dort, wo …" (¶65 "Mountain waves können überall dort auftreten, wo eine starke Strömung
    // in einer stabilen Atmosphäre auf eine Barriere trifft") — no named term, but the sentence is a mandatory fact;
    // run 9 had the cue for ranking only and never made it a fact
    if hitsHere.isEmpty && has(condWhereRe, s) { out.append(("", s0, "überall dort, wo", false, "condition-fact")) }
    // run 11: a parenthesis holding an accepted term is a hit on its own — it no longer has to rename the noun phrase
    // before it (¶19 "(stabile Schichtung)" sits after "…Luft", whose np fails okTerm; run 10 dropped all three classes).
    // Every qualifying parenthesis of the sentence counts (all three Schichtungen in ¶19).
    for m in rx(#"\(([^()]{3,60})\)"#).matches(in: s, range: NSRange(s.startIndex..., in: s)) {
      guard let rr = Range(m.range(at: 1), in: s) else { continue }
      let inner0 = norm(String(s[rr]))
      // run 12 (Glidr's score): the junk filter AND the formula check apply to the parenthesis path too — restore §§,
      // then junkTerm (der Deutsche, Ablösung tritt, Julius, Bart) and formulaDebrisRe (τTh−τLu) decide; run 11 only ran
      // okTerm here, which skipped junkTerm for a single generic/verb word and let Greek-letter captures through
      let inner = restoreAbbr(inner0)
      if has(formulaDebrisRe, inner) || junkTerm(inner) != nil { continue }
      if inner.contains(",") { continue }                                   // comma list: not a term
      let ws = inner.split(separator: " ")
      if ws.count > 4 { continue }                                          // clause, not a term
      if parenLeadBad.contains(String(ws.first ?? "").lowercased()) { continue }
      guard okTerm(inner).0 || has(abbrevTermRe, inner) else { continue }   // must hold a term
      hitsHere.append(("(" + inner + ")", norm(inner)))
    }
    if hitsHere.isEmpty {
      if !rejectReason.isEmpty { out.append(("", s0, "", false, rejectReason)) }
      continue
    }
    for h in hitsHere {
      // run 12: restore the §§ abbreviation placeholder before any term/output use — run 11 logged "engl§§ hydraulic
      // jump" and carried it into termsLost (#34); the sentence is restored too (s0 already is, the term was not)
      let (ok, why, termRaw) = okTerm(restoreAbbr(h.term), initialOk: has(anzeichenRe, abbrProtect(s0)))
      let term = restoreAbbr(termRaw)
      if ok { out.append((term, s0, h.cue, true, "accepted")) }
      else { out.append(("", s0, h.cue, false, "reject:" + why)) }
    }
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
  func consider(_ f0in: Fact, named: Bool, term: String, force: Bool = false) {
    // run 14 (#3): a quote spanning two sentences of OPPOSITE sides (Luv/Lee) is split — each sentence becomes its own fact
    let sides = splitOppositeSides(f0in.quote)
    if sides.count > 1 { for s in sides { consider(Fact(quote: s, statement: s), named: named, term: term, force: force) }; return }
    // run 14 (#63): a quote cut right after a sentence-initial "Da/Weil/Wenn/Obwohl" gets the conjunction back
    let f0 = Fact(quote: snapLeadingConj(f0in.quote, secText: sp.text), statement: f0in.statement)
    // run 13 fix 9 (Glidr's #48): a fact quote opening with "Diese/dieser/solche + noun" gets its ANTECEDENT — the previous
    // source sentence is prepended to the quote BEFORE the back is written, so the model cannot swap the subject
    // ("Diese Leewellen werden … durch die Bildung von charakteristischen Wolken, den Föhnlinsen …, sichtbar" became
    // "Föhnlinsen werden … sichtbar", the only wrong card of run 12); condition facts keep their verbatim sentence
    // a pulled-in antecedent is verbatim source text, so the quote stays verbatim by construction; a CONDITION fact keeps
    // its exact sentence (its quote was taken from the protected paragraph text and must stay byte-identical for the dedupe)
    // §§ restored for EVERY fact quote (run 13): a paragraph quote carries the protected form ("z§§ B§§"); run 12 only
    // restored it inside namedTermSentences, so card prompts and the verbatim check saw "§§" text
    let pul = (named || force) ? pullQuoteAntecedent(f0.quote, secText: sp.text) : (restoreAbbr(norm(f0.quote)), false)
    let f = Fact(quote: pul.0, statement: f0.statement)
    let q = norm(f.quote), st = norm(f.statement)
    // run 9 verbatim check: tag-stripped canonical text + dash/quote normalisation + in-order content-word fallback
    let verb = quoteVerbatim(f.quote, sp.text)
    var why = ""
    if q.isEmpty || st.isEmpty { why = "empty" }
    else if q.split(separator: " ").count < 6 { why = "quoteTooShort" }
    else if q.hasSuffix(":") { why = "listStub" }
    else if has(recapRe, q) { why = "recap" }
    else if overlapFrac(q, sp.heading) >= 0.99 && q.split(separator: " ").count < 10 { why = "heading" }
    // run 11 (Glidr's score): the summary-side formula-debris filter applies to flash FACTS too — #79 accepted the
    // garbled ¶36 formula `w=K1,1(τTh−τLu)−11,1(…)` as a card; a fact whose quote or statement is formula debris dies here
    else if has(formulaDebrisRe, q) || has(formulaDebrisRe, st) { why = "formulaDebris" }
    if why.isEmpty {
      let (p, g) = paraOf(sp, quote: f.quote, fallback: f.statement)
      if !named && !force && recs.filter({ $0.para == p && !$0.namedTerm }).count >= 2 { why = "paraCap" }
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
    for h in namedTermSentences(p.text, places: places) {
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
  // run 14 item 2 (Glidr's q176 "etwa 0,6 °C/100 m"): EVERY sentence with a number+unit yields a fact (outside the per-paragraph cap)
  // unless an existing fact of the paragraph already holds that sentence or its numbers; the sentence is the quote, verbatim
  let unitReN = rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#)
  for p in sp.paras {
    for sent in splitSentences(p.text).map({ restoreAbbr(norm($0)) }) where has(unitReN, sent) && sent.split(separator: " ").count >= 6 && !has(formulaDebrisRe, sent) {
      let ns = numbers(sent)
      let covered = recs.contains(where: { r in r.para == p.no && (canonV(r.quote).contains(canonV(sent)) || (!ns.isEmpty && ns.allSatisfy { n in r.quote.contains(n) })) })
      if covered { continue }
      consider(Fact(quote: sent, statement: "Zahlenwert: \(sent)"), named: false, term: "", force: true)
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

// run 12: backTrimmed is SOFT (Glidr's #70 was rejected for a trim that kept the content); backDemonstrative is soft —
// code already pulled the previous sentence when it could; backRevertedToFull is soft (a trim lost the verb, full kept)
// run 13: a term card carries the code-built front ("frontTermCard") — soft, the front is correct by construction
let softFlags: Set<String> = ["prefixStripped", "unsupportedVerdict", "quoteNotVerbatim", "stemDemonstrative", "verdictError", "backDeduped", "frontDemonstrative", "paraGuessed", "backTooLongQuote", "backTrimmed", "backDemonstrative", "backRevertedToFull", "frontTermCard", "backFromQuote", "backReordered", "backParensRepaired", "frontClashCodeQualified", "frontBackMismatchSoft"]
func isAccepted(_ flags: [String]) -> Bool { flags.allSatisfy { softFlags.contains(flagKey($0)) } }
// a code edit (term front, typo restore, list-tail strip) still puts the card in review, like backDeduped does
func isClean(_ flags: [String]) -> Bool { flags.allSatisfy { ["prefixStripped", "backDeduped", "frontTermCard", "backTyposRestored", "backListTailStripped"].contains(flagKey($0)) } }

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
  let fw = stems(f).subtracting(qWordList.map(deStem))
  let hw = stems(heading).subtracting(qWordList.map(deStem))
  let key = sb.subtracting(hw)            // distinguishing words: back content minus the heading's topic words
  if key.count < 3 { return (false, 0) }
  let frac = Double(key.intersection(fw).count) / Double(key.count)
  return (frac >= 0.8, frac)
}

/// run 11 named-term detector unit test (swift asserts, no model calls): the six Glidr sentences (¶8 ¶10 ¶19 ¶20 ¶62 ¶65)
/// plus ¶74 ("sog." must match through the abbreviation protection) and a junk sentence. Run BEFORE every pipeline run:
///   pipeline-probe-r12 --selftest [dir of sections] — with the dir, the real section paragraphs are checked too
func runSelftest(sectionsDir: String?) -> Int32 {
  var failed = 0; var passed = 0
  func check(_ name: String, _ cond: Bool, _ detail: String) {
    if cond { passed += 1; say("ok   \(name)") } else { failed += 1; say("FAIL \(name): \(detail)") }
  }
  let places: Set<String> = []
  func termsOf(_ sent: String) -> [String] { namedTermSentences(sent, places: places).filter { $0.accepted }.map { $0.term } }
  func dump(_ sent: String) -> String { namedTermSentences(sent, places: places).map { "[\($0.cue)|\($0.term)|\($0.reason)]" }.joined() }
  // ¶8 "spricht man von Blauthermik" — no one-hit-per-sentence cap: the SAME sentence keeps Cumulus AND Blauthermik
  // run 12: the paragraph text keeps §§ ("z. B." stays "z§§ B§§"), so every test sentence is abbrProtect'ed here —
  // that feeds namedTermSentences exactly what a real section paragraph looks like now
  let p8 = abbrProtect("Cumuluswolken sind somit ein sichtbares Anzeichen für Thermik. Ist die Luft zu trocken, so dass keine Wolkenbildung eintritt, spricht man von Blauthermik – der Himmel bleibt wolkenlos und blau.")
  check("para8-Blauthermik", termsOf(p8).contains("Blauthermik"), "terms: \(dump(p8))")
  // ¶10 "spricht man von pulsierender Thermik" — ADJ+NOUN captured and dictionary-formatted
  let p10 = abbrProtect("Bei diesen wiederkehrenden Aufwinden an gleicher Stelle spricht man von pulsierender Thermik.")
  check("para10-pulsierendeThermik", termsOf(p10) == ["pulsierende Thermik"], "terms: \(dump(p10))")
  // ¶19 the three parenthesised classes, one hit each (no cap, no rename-a-noun-phrase requirement)
  let p19 = abbrProtect("Da sich Luft beim Aufsteigen bis zum Erreichen des Kondensationsniveaus konstant mit 1 °C je 100 m abkühlt, würde bei einem Gradienten unter 1 °C aufsteigende Luft bald kälter werden als die umgebende Luft (stabile Schichtung). Bei einem Gradienten von 1 °C (indifferente Schichtung) bleibt die Temperaturdifferenz mit zunehmender Höhe gleich und führt zu mittelmäßiger bis guter Thermik bei gleich bleibenden Steigwerten. Beträgt der Gradient über 1 °C (labile Schichtung), nimmt die Temperaturdifferenz mit der Höhe entsprechend zu – ebenso die Steigwerte und Thermikstärke.")
  let t19 = termsOf(p19)
  check("para19-Schichtungen", ["stabile Schichtung","indifferente Schichtung","labile Schichtung"].allSatisfy { t19.contains($0) }, "terms: \(t19)")
  // ¶20 "sog." must match (the abbreviation protection must not eat the cue)
  say("dbg: " + dump(abbrProtect("Das ist dem sog. Rückseitenwetter.")) + " / " + dump(abbrProtect("Das ist dem sogenannten Rückseitenwetter.")))
  let p20 = abbrProtect("Sie tritt ein, wenn kühlere Luftmassen in höheren Luftschichten von einer anderen Stelle herbeigeführt werden wie z. B. nach dem Durchgang einer Kaltfront, dem sog. Rückseitenwetter.")
  check("para20-Rueckseitenwetter", termsOf(p20).contains("Rückseitenwetter"), "terms: \(dump(p20))")
  // ¶62 Totluft (worked before — regression guard)
  let p62 = abbrProtect("Diese Luft wird daher auch Totluft genannt.")
  check("para62-Totluft", termsOf(p62).contains("Totluft"), "terms: \(termsOf(p62))")
  // ¶65 the "überall dort, wo" cue fires as a condition fact
  let p65 = abbrProtect("Mountain waves können überall dort auftreten, wo eine starke Strömung in einer stabilen Atmosphäre auf eine Barriere trifft.")
  check("para65-condition", namedTermSentences(p65, places: places).contains { $0.reason == "condition-fact" }, "hits: \(namedTermSentences(p65, places: places))")
  // ¶74 "der sogenannte Albföhn" — sog. cue on a fragment must yield the term (run 10 gave '')
  let p74 = abbrProtect("der sogenannte Albföhn der Schwäbischen Alb bei Südostwinden, der das Segelfliegen am Albtrauf ermöglicht")
  check("para74-Albfoehn", termsOf(p74).contains("Albföhn"), "terms: \(dump(p74))")
  // junk filter AFTER capture: Föhn / Umgebung / "Ablösung tritt" / generic words / years never become accepted terms
  let pj = abbrProtect("Der Föhn ist ein Wind in der Umgebung des Gebirges. Die Ablösung tritt dabei auf.")
  let tj = termsOf(pj)
  check("junk-filter", tj.isEmpty, "terms: \(tj)")
  check("junk-topic-word", !termsOf(abbrProtect("Heute spricht man von Föhn.")).contains("Föhn"), "terms: \(termsOf(abbrProtect("Heute spricht man von Föhn.")))")
  // ---- run 12 selftest cases (Glidr's run-11 score) ----
  // junk on the parenthesis/cue paths: der Deutsche, Ablösung tritt, Julius, Bart never become named terms
  let pde = abbrProtect("Als ‚der Deutsche‘ wird er gern gebraucht.")   // no finite verb in the sentence, so no cue can fire either
  check("junk-der-deutsche", !termsOf(pde).contains(where: { $0.lowercased().contains("deutsche") }), "terms: \(dump(pde))")
  let pju = abbrProtect("Wird gern thermodynamisch genannt, nach Julius Magenta.")   // a name after the cue must not be a term
  check("junk-person-name", !termsOf(pju).contains(where: { $0.lowercased() == "julius" }), "terms: \(dump(pju))")
  let pab = abbrProtect("Die sogenannte Ablösung tritt an der Lee­seite auf.")
  check("junk-abloesung", !termsOf(pab).contains(where: { $0.lowercased().contains("ablösung") }), "terms: \(dump(pab))")
  // formula captures on the parenthesis path are junk (τTh−τLu, ϑLu−τLu)
  let pfo = abbrProtect("Die Stärke hängt von der Differenz (τTh−τLu) und (ϑLu−τLu) ab.")
  check("junk-formula-paren", termsOf(pfo).isEmpty, "terms: \(dump(pfo))")
  // the §§ placeholder is restored in every emitted term ("engl§§ hydraulic jump" -> "engl. hydraulic jump")
  let peng = abbrProtect("Man nennt das einen hydraulischen Sprung (engl. hydraulic jump).")
  check("abbr-restored-term", !termsOf(peng).contains(where: { $0.contains("§§") }), "terms: \(dump(peng))")
  // stem match: an inflected form of a term counts as the term itself
  check("stem-inflection", deStem("pulsierender") == deStem("pulsierende") && deStem("Aufwinds") == deStem("Aufwindes"),
        "deStem pulsierender=\(deStem("pulsierender")) pulsierende=\(deStem("pulsierende")); Aufwinds=\(deStem("Aufwinds")) Aufwindes=\(deStem("Aufwindes"))")
  // front grammar: no finite verb -> flagged; a dangling article / "die Zahl" antecedent -> flagged
  // "Föhnkühler" is a noun, not a verb; the -t tail of "als" is shorter than {3,} requires
  check("front-no-verb", !frontHasFiniteVerb("Was ist der Föhnkühler als Auslöser?") && frontVagueSubject("Was ist der deutsche Fremdwort-Begriff?"), "fhv=\(frontHasFiniteVerb("Was ist der Föhnkühler als Auslöser?")) vague=\(frontVagueSubject("Was ist der deutsche Fremdwort-Begriff?"))")
  check("front-with-verb", frontHasFiniteVerb("Wann spricht man vom Föhnsturm?"), "spricht is a finite verb")
  // run 12 first-run fix: only a BARE noun is dangling — "die Bezeichnung Föhn" and "die Zahl für die Strömung" name
  // their referent and must NOT be flagged (18/93 over-fire); a bare "Was bedeutet die Zahl?" must
  check("front-dangling", hasFrontDanglingAntecedent("Was bedeutet die Zahl?") && !hasFrontDanglingAntecedent("Was ist die Bezeichnung Föhn?") && !hasFrontDanglingAntecedent("Was bedeutet die Zahl für die Strömung?"), "bare noun flagged, named noun kept")
  // run 12 fix: plural/preterite W-question verbs and numeric terms kept by digit run (no over-firing)
  check("front-plural-verb", frontHasFiniteVerb("Wie treten Mountain waves auf?") && frontHasFiniteVerb("Wie entstand der Fachbegriff?"), "second-position lowercase verb")
  check("term-kept-number", termKept("1,0 °c", back: "Pro 100 m kühlt sie sich um 1 °C ab.", backStems: stemWords("Pro 100 m kühlt sie sich um 1 °C ab.")) && !termKept("0,6 °c", back: "Sie kühlt sich ab.", backStems: stemWords("Sie kühlt sich ab.")) && termKept("west-ost", back: "von Westen nach Osten in West-Ost-Richtung", backStems: stemWords("von Westen nach Osten in West-Ost-Richtung")), "digits/hyphen")
  // summaries: demonstrative pick, ":" stubs and verbless list items are caught in code
  check("demo-start", startsWithDemonstrative("Diese Luft wird daher auch Totluft genannt.") && startsWithDemonstrative("Das führt zu einer Erwärmung."), "Diese/Das leading")
  check("verbless-item", !sentenceHasFiniteVerb("Messung des Windfeldes mittels verschiedener Radartechniken, RADAR, LIDAR, SODAR"), "list item has no finite verb")
  // norm() collapses the space BEFORE the comma, so the test checks the debris is gone (no " ," / " ." anywhere)
  check("clean-spacing", !cleanSpacing("den Föhnlinsen , sichtbar um Höhe zu gewinnen .").contains(" ,") && !spacingOf(cleanSpacing("Höhe . am")).contains("_."), spacingOf(cleanSpacing("den Föhnlinsen , sichtbar um Höhe zu gewinnen .")))
  // ---- run 13 selftest cases (Glidr's run-12 score) ----
  // splitter: "resp." must NOT end a sentence (#82); resp./bzw./ca./u. a./u. U./z. B./sog./engl. all protected
  let sResp = splitSentences("Die Messung des elektrischen Feldes resp. dessen Gradienten sind Rückschlüsse möglich. Danach kommt nichts.")
  check("split-resp", sResp.count == 2 && sResp[0].contains("resp."), "sentences: \(sResp)")
  let sAbbr = splitSentences(abbrProtect("Das gilt z. B. für sog. Wolken bzw. ca. 3 km und u. a. Bergwellen, engl. mountain waves, u. U. auch später."))
  check("split-abbr-all", sAbbr.count == 1 && !sAbbr[0].contains("§§"), "sentences: \(sAbbr)")
  // term-card front (fix 1): "Was ist <Term>?", plural "sind", lowercase terms take the "Was versteht man unter …?" form
  check("term-front", termFront("Rückseitenwetter") == "Was ist Rückseitenwetter?" && termFront("pulsierende Thermik") == "Was ist pulsierende Thermik?" && termFront("Steigungsregen") == "Was ist Steigungsregen?", "tf=\(termFront("Rückseitenwetter")) / \(termFront("pulsierende Thermik")) / \(termFront("Steigungsregen"))")
  // a term card keeps the code front: it IS a W-question; the copula-only grammar rule ("Was ist X?" has no real asking
  // verb) stays exactly as run 12 had it — a TERM card is exempt from frontNoFiniteVerb because its answer IS the definition
  check("term-front-grammar", isQuestion(termFront("Rückseitenwetter")) && !frontHasFiniteVerb("Was ist der Föhnkühler?") && !hasFrontDanglingAntecedent(termFront("Rückseitenwetter")), "copula rule unchanged, term front not dangling")
  // engl. stripped at capture (#31): the term becomes "hydraulic jump" (no dot, no §§), and a §§ cue never leaks into the log
  let pEng = abbrProtect("Die Flüssigkeit passt sich auf der Leeseite durch einen hydraulischen Sprung (engl. hydraulic jump) wieder der Umgebung an.")
  let hEng = namedTermSentences(pEng, places: [])
  check("engl-stripped-term", hEng.contains(where: { $0.accepted && $0.term == "hydraulic jump" }) && !hEng.contains(where: { $0.term.contains("engl") || $0.term.contains("§§") }), "hits: \(dump(pEng))")
  let pSog = abbrProtect("Sie tritt ein nach dem Durchgang einer Kaltfront, dem sog. Rückseitenwetter.")
  check("cue-no-placeholder-leak", !namedTermSentences(pSog, places: []).contains(where: { $0.cue.contains("§§") }), "cues: \(dump(pSog))")
  // junk terms (#85/#33/#32/#72/#13): Umgebung, clause captures, value descriptions and quote fragments never become terms
  check("junk-umgebung", !termsOf(abbrProtect("Thermik führt aufgrund der geringeren Temperaturdifferenz (Ballonhülle zur Umgebung) zum Sinken.")).contains("Umgebung"), "terms: \(termsOf(abbrProtect("Thermik führt aufgrund der geringeren Temperaturdifferenz (Ballonhülle zur Umgebung) zum Sinken.")))")
  check("junk-clause-capture", !termsOf(abbrProtect("Auf der Leeseite heißt es, das Wasser strömt langsamer.")).contains(where: { $0.lowercased().contains("langsamer") }) && !termsOf(abbrProtect("Eine mit überkritischer Geschwindigkeit strömende Luft nennt man schießend.")).contains(where: { $0.lowercased().contains("geschwindigkeit strömend") }), "clause captures must die")
  // a value description built on an adjective ("kleiner Albedowert", #72) is junk even when a cue fires on it
  check("junk-value-description", !termsOf(abbrProtect("Einen kleinen Albedowert nennt man in der Meteorologie selten so.")).contains(where: { $0.lowercased().contains("albedowert") }), "terms: \(termsOf(abbrProtect("Einen kleinen Albedowert nennt man in der Meteorologie selten so.")))")
  check("junk-quote-fragment", !namedTermSentences(abbrProtect("Als ‚Fallwind‘ wird er bezeichnet."), places: []).contains(where: { $0.accepted && $0.term.contains("‚") }), "terms: \(dump(abbrProtect("Als ‚Fallwind‘ wird er bezeichnet.")))")
  // matcher leak (#87): a trailing comma-list of lowercase keywords is stripped from the back, a normal sentence is kept
  let (lt, lch) = stripListTail("Die Thermik entsteht durch Erwärmung, thermik, umgebungsluft, dichteunterschiede, höhe.")
  check("list-tail-stripped", lch && !lt.contains("umgebungsluft") && lt.hasSuffix("Erwärmung."), "after: \(lt)")
  let (lt2, lch2) = stripListTail("Sie kühlt sich dabei feuchtadiabatisch mit etwa 0,6 °C/100 m ab.")
  check("list-tail-kept", !lch2 && lt2.contains("feuchtadiabatisch"), "normal back kept: \(lt2)")
  // front/back mismatch (#8/#10): nouns the front asks about must sit in the back or the fact quote
  check("mismatch-caught", frontBackMismatch("Wie verhält sich die Luft durch feuchtadiabatisch aufsteigende Luft nach dem Gebirge?", back: "Der Südföhn wird durch eine Südströmung über die Alpen charakterisiert.", quote: "Südseitig strömt die Luft über das Hindernis."), "front nouns not in back/quote")
  check("mismatch-kept", !frontBackMismatch("Wann spricht man vom Föhnsturm?", back: "Bei stürmischem Südwind spricht man vom Föhnsturm.", quote: "tritt der Föhnsturm auf"), "front nouns sit in the back")
  // finite verb on EVERY back sentence (#52/#54/#81): a fragment inside a multi-sentence back is caught
  check("back-fragment-caught", !backSentenceFragments("Der Albföhn ermöglicht das Segelfliegen. Albföhn der Schwäbischen Alb bei Südostwinden.").isEmpty, "verbless second sentence")
  check("back-verbs-ok", backSentenceFragments("Das Fliegen in einer Wolke ist mit Risiken verbunden und wird selten praktiziert.").isEmpty, "two complete sentences")
  // typo restore (#18): exactly one source word at edit distance 1 is restored; a far-off or ambiguous word stays
  // "abgeregierte" sits in NEITHER the quote nor the section; the section's only word at edit distance 1 is "abgeregnete"
  let (rt, rfix) = restoreTypos("Es fehlt die abgeregierte Wassermenge.", quote: "Die absinkende Luft erwärmt sich wieder trockenadiabatisch mit durchgehend 1 °C/100 m.", secText: "Die vorher abgeregnete Wassermenge ist auf der Leeseite die Ursache für die relative Trockenheit des Föhnwindes.")
  check("typo-restored", rfix == ["abgeregierte->abgeregnete"] && rt.contains("abgeregnete"), "fixed: \(rfix) back: \(rt)")
  let (rt2, rfix2) = restoreTypos("Die abgeröselte Masse fehlt.", quote: "x y z", secText: "nichts Verwandtes steht hier")
  check("typo-not-guessed", rfix2.isEmpty && rt2.contains("abgeröselte"), "far word stays: \(rfix2)")
  // demonstrative in the FACT QUOTE (#48): the previous sentence is pulled in before the back is written
  let sec64 = "Auf der Leeseite des Gebirges gerät die strömende Luft in Schwingungen. Diese Leewellen werden bei ausreichender Luftfeuchtigkeit durch die Bildung von charakteristischen Wolken, den Föhnlinsen (Altocumulus lenticularis, kurz Ac lent), sichtbar."
  let (rq, rp) = pullQuoteAntecedent("Diese Leewellen werden bei ausreichender Luftfeuchtigkeit durch die Bildung von charakteristischen Wolken, den Föhnlinsen (Altocumulus lenticularis, kurz Ac lent), sichtbar.", secText: sec64)
  check("quote-antecedent-pulled", rp && rq.hasPrefix("Auf der Leeseite des Gebirges gerät die strömende Luft in Schwingungen."), "pulled: \(String(rq.prefix(60)))")
  let (rq2, rp2) = pullQuoteAntecedent("Die absinkende Luft erwärmt sich wieder trockenadiabatisch.", secText: sec64)
  check("quote-antecedent-untouched", !rp2 && rq2.contains("absinkende"), "plain quote unchanged")
  // ---- run 14 selftest cases (Glidr's run-13 score) ----
  // item 3: finite-verb lexicon — false positives #10 (separable "ging … ein"), #22 "treten", #51 "sind/treten"; misses #11, #52, #37
  check("verb-10-ging-ein", sentenceHasFiniteVerb("Die Bezeichnung Föhn ging vom lateinischen favonius „lauer Westwind“ wohl über das Rätoromanische (favuogn, dialektal auch fuogn) in das Althochdeutsche (phōnno) ein."), "ging … ein")
  check("verb-22-treten", sentenceHasFiniteVerb("Daher treten viele atmosphärische Turbulenzen als Wellen auf."), "treten")
  check("verb-51-sind-treten", sentenceHasFiniteVerb("Weniger bekannt, in der Praxis aber recht verbreitet, sind schwächere Föhneffekte im Lee von niedrigeren Geländestufen und Mittelgebirgszügen.") && sentenceHasFiniteVerb("Typischerweise treten solche Effekte bei starker Warmluftadvektion in den Wintermonaten auf."), "sind / treten")
  check("verb-11-fonvind-verbless", !sentenceHasFiniteVerb("Der 'Norwegen-Föhn' (fønvind), ein Nordwind, der sich am norwegischen Gebirgsmassiv abregnet und, soweit er über Land (und nicht über die Ostsee oder Nordsee) zieht, zu wolkenarmem Wetter in Schleswig-Holstein und Hamburg führt."), "relative-clause verbs must not count")
  check("verb-52-albfoehn-verbless", !sentenceHasFiniteVerb("Der sogenannte Albföhn der Schwäbischen Alb bei Südostwinden, der das Segelfliegen am Albtrauf ermöglicht."), "fragment")
  check("verb-37-participle-only", !sentenceHasFiniteVerb("Die Südströmung bei Südföhnlagen für den Bereich der Ostalpen im Raum von Tirol mit der Wirkung des Föhns als Südwind immer durch eine entsprechende Erhöhung der Temperaturmaxima charakterisiert."), "participle-final, no aux")
  check("verb-ok-simple", sentenceHasFiniteVerb("Der Wind weht.") && sentenceHasFiniteVerb("Obwohl die Atmosphäre aus Gasen aufgebaut ist, verhält sie sich in vielen Fällen wie eine Flüssigkeit.") && sentenceHasFiniteVerb("Mountain waves können überall dort auftreten, wo eine starke Strömung auf eine Barriere trifft."), "plain sentences")
  // item 2: number+unit sentence (¶32 s3 "etwa 0,6 °C/100 m") is recognised as a number sentence
  check("number-sentence-unit", has(rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#), "Beim Absinken kühlt sich die Luft feuchtadiabatisch um etwa 0,6 °C/100 m ab."), "0,6 °C")
  // item 5: typo restore — OOV only, never an inflection of the same stem
  let (ri1, rf1) = restoreTypos("Die herabströmenden Luft erwärmt sich.", quote: "die herabströmende Luft", secText: "Die herabströmende Luft erwärmt sich stark am Hang.", vocab: ["herabströmenden"])
  check("typo-inflection-kept", rf1.isEmpty && ri1.contains("herabströmenden"), "fixed \(rf1): \(ri1)")
  let (ri2, rf2) = restoreTypos("Die herabströmenden Luft erwärmt sich.", quote: "die herabströmende Luft", secText: "Die herabströmende Luft erwärmt sich stark am Hang.")
  check("typo-same-stem-kept", rf2.isEmpty && ri2.contains("herabströmenden"), "fixed \(rf2): \(ri2)")
  check("same-stem", sameStemWord("strömenden", "strömende") && sameStemWord("erreichen", "erreicht") && !sameStemWord("abgeregierte", "abgeregnete"), "stem rule")
  // item 6: hyphen compounds and stems in the mismatch check (#12 "Lee-Seite" vs "Lee-")
  check("mismatch-hyphen", !frontBackMismatch("Wie erklärt die Theorie die hohen Temperaturen auf der Lee-Seite?", back: "Die Charakteristika der Theorie sind ein Niederschlag im Luv, der als alleinige Erklärung der relativ hohen Temperaturen auf der Lee- im Vergleich zur Luvseite herangezogen wird.", quote: "Diese Theorie ist nur noch von historischer Bedeutung."), "Lee-Seite ~ Lee-/Luvseite")
  // item 7: junk terms (#23, #34) never become a term; "das heißt" is not a cue; dash appositive names a term; fronts are "Was ist …?"
  check("junk-clause-verb-23", junkTerm("Wasser strömt langsamer") != nil && termIsJunk("Wasser strömt langsamer"), "clause with a finite verb")
  check("junk-np-tail-34", junkTerm("Geschwindigkeit strömendes") != nil, "capitalised noun + lower-case adjective tail")
  check("junk-keeps-real-terms", junkTerm("pulsierende Thermik") == nil && junkTerm("hydraulic jump") == nil && junkTerm("schießend strömende Luft") == nil && junkTerm("Cascade Windstorm") == nil, "real terms pass")
  let pDas = abbrProtect("Kinetische Energie wird am Hindernis in potenzielle Energie umgewandelt (das heißt, Wasser strömt langsamer, hat aber am Gipfel potenzielle Energie).")
  check("das-heisst-no-term", termsOf(pDas).isEmpty, "terms: \(dump(pDas))")
  let pDash = abbrProtect("Typisch für die Föhnlage ist eine markante Wolkenwand – die Föhnmauer – vor fast blauem Himmel, dem Föhnfenster.")
  check("dash-appositive", termsOf(pDash).contains("Föhnmauer") && termsOf(pDash).contains("Föhnfenster"), "terms: \(dump(pDash))")
  // item 1/8/9: Luv/Lee quote split, pull-in once / before, source order, parentheses, leading conjunction
  check("split-opposite-sides", splitOppositeSides("Die Luft kühlt sich auf der Luvseite ab. Auf der Leeseite erwärmt sie sich wieder.").count == 2 && splitOppositeSides("Auf der Luvseite regnet es. Das Gebirge ist hoch.").count == 1, "luv/lee")
  let secP = "Hier ist die Luft der unteren Schichten im Pool gefangen und tritt nicht über den Alpenhauptkamm. Diese Luft wird daher auch Totluft genannt."
  let (pp1, pd1) = pullPrevious("Diese Luft wird daher auch Totluft genannt.", secText: secP)
  check("pull-before", pd1 && pp1.hasPrefix("Hier ist die Luft"), pp1)
  let (pp2, pd2) = pullPrevious("Hier ist die Luft der unteren Schichten im Pool gefangen und tritt nicht über den Alpenhauptkamm. Diese Luft wird daher auch Totluft genannt.", secText: secP)
  check("pull-never-twice", !pd2 && pp2.components(separatedBy: "Hier ist").count == 2, pp2)
  let (ob1, oc1) = orderBySource("Die Strömungsgeschwindigkeit in diesem Kanal nimmt ständig zu. Ein heranziehendes Tief beginnt die Kaltluft durch den Kanal abzusaugen.", secText: "Ein heranziehendes Tief beginnt die Kaltluft durch den Kanal abzusaugen. Die Strömungsgeschwindigkeit in diesem Kanal nimmt ständig zu.")
  check("back-source-order", oc1 && ob1.hasPrefix("Ein heranziehendes Tief"), ob1)
  let (bp1, bc1) = balanceParens("Die Froudsche Zahl F drückt das Verhältnis zwischen kinetischer Energie und potenzieller Energie (Stabilität, Gebirgshöhe aus.", secText: "potenzieller Energie (Stabilität, Gebirgshöhe) aus.")
  check("parens-balanced", bc1 && bp1.filter { $0 == "(" }.count == bp1.filter { $0 == ")" }.count && bp1.contains("Gebirgshöhe) aus"), bp1)
  check("conj-snap", snapLeadingConj("die Luft vor allem in einer labil geschichteten Atmosphäre leicht aufsteigt und sich dabei abkühlt, kann sie Wolken bilden.", secText: "Da die Luft vor allem in einer labil geschichteten Atmosphäre leicht aufsteigt und sich dabei abkühlt, kann sie Wolken bilden.").hasPrefix("Da die"), "Da restored")
  check("side-merge", sideMerge("Die Luft auf der Luvseite des Gebirges ist mit Steigungsregen verbunden und erfährt eine deutliche Erwärmung und Trocknung der herabströmenden Luft.", secText: "Sie ist auf der Luvseite des Gebirges mit Steigungsregen verbunden. Charakteristisch ist die deutliche Erwärmung und Trocknung der herabströmenden Luft."), "luv + lee effects merged")
  // item 10: parenthesis trim keeps a parenthesis holding an accepted term
  check("trim-keeps-term-paren", trimParentheticals("Bei einem Gradienten unter 1 °C (stabile Schichtung) kühlt die Luft ab (siehe Abbildung).", keep: ["stabile Schichtung"]).contains("(stabile Schichtung)") && !trimParentheticals("Bei einem Gradienten unter 1 °C (stabile Schichtung) kühlt die Luft ab (siehe Abbildung).", keep: ["stabile Schichtung"]).contains("Abbildung"), trimParentheticals("Bei einem Gradienten unter 1 °C (stabile Schichtung) kühlt die Luft ab (siehe Abbildung).", keep: ["stabile Schichtung"]))
  // on the REAL sections: ¶8 Blauthermik and ¶20 Rückseitenwetter must be captured where they live
  if let d = sectionsDir, let names = try? FileManager.default.contentsOfDirectory(atPath: d) {
    var foundB = false, foundR = false
    for nm in names.filter({ $0.hasSuffix(".txt") }) {
      guard let raw = try? String(contentsOfFile: d + "/" + nm, encoding: .utf8) else { continue }
      for p in cleanSection(raw).paras {
        let ts = namedTermSentences(p.text, places: placeNames(cleanSection(raw).body)).filter { $0.accepted }.map { $0.term }
        if ts.contains("Blauthermik") { foundB = true }
        if ts.contains("Rückseitenwetter") { foundR = true }
      }
    }
    check("sections-Blauthermik", foundB, "no Blauthermik capture in any section paragraph")
    check("sections-Rueckseitenwetter", foundR, "no Rückseitenwetter capture in any section paragraph")
  }
  say("selftest: \(passed) passed, \(failed) failed")
  return failed == 0 ? 0 : 1
}

@main struct Pipeline {
  static func main() async {
    setvbuf(stdout, nil, _IOLBF, 0)
    let a = CommandLine.arguments
    // run 11: --selftest runs the named-term detector unit test and exits (no model calls)
    if a.count >= 2 && a[1] == "--selftest" { exit(runSelftest(sectionsDir: a.count > 2 ? a[2] : nil)) }
    // run 14: --verbscan <sections dir>: lists the section sentences (>= 5 words) the finite-verb check calls verbless, no model call
    if a.count >= 3 && a[1] == "--verbscan" {
      var tot = 0, bad = 0
      for nm in ((try? FileManager.default.contentsOfDirectory(atPath: a[2])) ?? []).filter({ $0.hasSuffix(".txt") }).sorted() {
        guard let raw = try? String(contentsOfFile: a[2] + "/" + nm, encoding: .utf8) else { continue }
        for p in cleanSection(raw).paras { for s in splitSentences(p.text).map({ restoreAbbr(norm($0)) }) where s.split(separator: " ").count >= 5 { tot += 1; if !sentenceHasFiniteVerb(s) { bad += 1; say("VERBLESS \(nm) ¶\(p.no): \(s.prefix(110))") } } }
      }
      say("verbscan: \(bad)/\(tot) verbless"); exit(0)
    }
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
    for sp in secs { globalVocab.formUnion(words(canonV(restoreAbbr(sp.text)))) }
    var placesByArticle: [String: Set<String>] = [:]
    for sp in secs { placesByArticle[sp.article, default: []].formUnion(placeNames(sp.text)) }
    var report: [String: Stats] = [:]
    var fcs: [FC] = []

    // ---------------- 8a flashcards ----------------
    if modes.contains("flash") {
      let path = "\(out)/flashcards.jsonl", fpath = "\(out)/facts-flash.jsonl", tpath = "\(out)/named-terms.jsonl"
      for p in [path, fpath, tpath] { try? "".write(toFile: p, atomically: true, encoding: .utf8) }
      var st = Stats(); let t0 = Date()
      // run 11: the "Wie verhält sich X wie?" example is GONE (Glidr's score: it leaked to 10 accepted cards as a broken
      // template); a front must never end in '… wie?' and must not ask about a word the back answers as its subject
      let base = "You write flashcards from the given text only, in \(lang). Everything must be supported by the text. If the text contains a garbled formula, a lost symbol or an inconsistent number, do not build a card on it. Never ask about figures or tables. Write ONE flashcard about the given fact: the front is a QUESTION in German that starts with a W-question word and names its subject explicitly, never a bare term and never 'diese Effekte', 'solche', 'dies' without saying what is meant. Pick the question word that fits the answer: 'Was…?' for a thing or definition; 'Wie…?' for a manner or process ('Wie schnell steigt eine Thermik?'); 'Wann…?' for a time or condition ('Wann spricht man vom Föhnsturm?'); 'Wo…?' for a place; 'Wozu…?' for a purpose ('Wozu benötigt die Thermik Warmluft?'); 'Warum/Wodurch…?' for a cause — never force 'Was' where the answer is not a thing. The front must NOT end in '… wie?' and must not put the back's key term into the question as its subject (if the back answers with the word 'Intensität', do not ask 'Wie beeinflusst X die Intensität?'). The back is a short precise answer (one or two sentences, no sentence twice and no paraphrase of it either) in the wording of the text that keeps every technical term and every number with unit of the supporting quote; supportingQuote copied verbatim from the text."
      // run 10: fronts plus the fact statement they were built on — a clash needs BOTH a Jaccard >= 0.7 front AND a
      // >= 0.5 overlap of the two facts (Glidr's run-9 score: min-normalised overlap dropped 20 unique cards)
      var frontsByArticle: [String: [(front: String, back: String, fact: String)]] = [:]
      for sp in secs {
        let secId = sp.article + "-" + sp.no
        let fl = await extractFacts(sp, places: placesByArticle[sp.article] ?? [], lang: lang, stats: &st, factsPath: fpath, termHitsPath: tpath)
        for factIn in fl {
          // run 14 item 7: the junk filter runs BEFORE the term-card template — a junk/clause term never gets "Was ist <Term>?"
          var fact = factIn
          if fact.namedTerm && termIsJunk(fact.term) { fact.namedTerm = false; fact.term = "" }
          var logs: [CallLog] = []
          func gen(hint: String?, avoid: [String]) async -> Flashcard? {
            var prompt = "Section title: \(sp.heading)\n\nText:\n\n\(sp.text)\n\nFact: \(fact.statement)\nSupporting quote: \(fact.quote)\n\nWrite one flashcard in \(lang) that tests exactly this fact. The front is a question naming the subject of the section/fact explicitly, with the RIGHT question word: 'Was…?' only when the answer is a thing or definition; otherwise 'Wie…?' (manner/behaviour), 'Wann…?' (time/condition), 'Wo…?' (place), 'Wozu…?' (purpose), 'Warum…?' (cause). Examples: 'Wann spricht man vom Föhnsturm?', 'Wozu benötigt die Thermik Warmluft von unten?', 'Was ist ein Föhnfenster?'. Never end the question in 'wie?', and never ask about a word the answer itself supplies as its subject."
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
          // run 12 (Glidr's score): the sentence of the section that ACTUALLY supports the back — termsLost runs
          // against this, not against the whole factQuote (#50 lost words from other sentences of a two-sentence quote)
          // run 12 fix after the first full run: a back is often a PARAPHRASE, so matching whole sentences at 0.5 fell
          // back to the whole factQuote and termsLost over-fired again (29/93). Match at sentence level first, then per
          // clause against the section; if nothing matches the model wrote freely — no restriction is imposed then
          func usedSentences(_ back: String) -> String {
            let secSents = sp.paras.flatMap { splitSentences($0.text) }.map(norm)
            // run 14 (#20 #86 #48): per back sentence the BEST single source sentence (the largest share of the BACK sentence's
            // stems found in it, >= 0.6); of that source sentence only the comma clauses the back actually carries (>= 50 % of
            // the clause's stems in the back) count — a clause the back dropped or trimmed away loses nothing
            var joined = ""
            for b in splitSentences(norm(back)).map(norm) {
              let sb = stems(b); if sb.isEmpty { continue }
              var best: (String, Double)? = nil
              for s in secSents { let f = Double(sb.intersection(stems(s)).count) / Double(sb.count); if f >= 0.6 && f > (best?.1 ?? 0) { best = (s, f) } }
              if let (m, _) = best {
                let clauses = m.components(separatedBy: ", ").map(norm).filter { !$0.isEmpty }
                let carried = clauses.filter { cl in let sc = stems(cl); return !sc.isEmpty && Double(sc.intersection(sb).count) / Double(sc.count) >= 0.5 }
                joined += " " + (carried.isEmpty ? m : carried.joined(separator: ", "))
                continue
              }
              for cl in b.components(separatedBy: ", ").map(norm) where cl.split(separator: " ").count >= 4 {
                let sc = stems(cl); guard !sc.isEmpty else { continue }
                var bc: (String, Double)? = nil
                for s in secSents { let f = Double(sc.intersection(stems(s)).count) / Double(sc.count); if f >= 0.6 && f > (bc?.1 ?? 0) { bc = (s, f) } }
                if let (m, _) = bc { joined += " " + m }
              }
            }
            return restoreAbbr(joined)
          }
          func checks(_ c0in: Flashcard) -> (Flashcard, [String]) {
            var c = c0in; var flags: [String] = []
            // run 13 fix 2 (Glidr's #78/#87): NO matcher text in the output — §§ restored on both sides (run 12 emitted
            // "kaltluftadvektion" lowercased from the stem matcher into a back), and a trailing comma-run of lowercase
            // keywords ("…, thermik, umgebungsluft, dichteunterschiede, höhe") is stripped: that list came from an
            // answer-repair, never from the text
            c.front = restoreAbbr(norm(c.front)); c.back = restoreAbbr(norm(c.back)); c.supportingQuote = restoreAbbr(norm(c.supportingQuote))
            let (tb, tch) = stripListTail(c.back); if tch { c.back = tb; flags.append("backListTailStripped") }
            let (tf, tchf) = stripListTail(c.front); if tchf { c.front = tf; flags.append("frontListTailStripped") }
            let (b, dd) = dedupSentences(c.back); c.back = b; if dd { flags.append("backDeduped") }
            // run 9: canonical verbatim (tags stripped, dashes/quotes unified, in-order content-word fallback)
            if !quoteVerbatim(c.supportingQuote, sp.text) { flags.append("quoteNotVerbatim") }
            // run 12 (Glidr's score): answerWordsMissing only counts NOUNS and numbers, looked up SECTION-WIDE —
            // verbs the model adds ("entstehen", "erfolgt") and translated terms ("Bergwellen" for "mountain waves",
            // section ¶64/65 uses both) no longer kill a card; invented words are still caught (#10/#37 stay rejected)
            // run 13 fix 8 (Glidr's #18 "abgeregierte", 4th run): BEFORE the noun check, a back word that is neither verbatim
            // in the fact quote nor anywhere in the section is RESTORED when it differs from exactly one source word by one
            // edit ("abgeregierte" -> "abgeregnete"); an ambiguous or far-off word stays and answerWordsMissing rejects the card
            let (rb, rfix) = restoreTypos(c.back, quote: fact.quote, secText: sp.text, vocab: globalVocab)
            if !rfix.isEmpty { c.back = rb; flags.append("backTyposRestored:" + rfix.joined(separator: ",")) }
            let bn = nounTokens(c.back); let secNouns = nounTokens(sp.text)
            let missing = bn.filter { !secNouns.contains($0) }
            if !bn.isEmpty && !missing.isEmpty { flags.append("answerWordsMissing:" + missing.prefix(6).joined(separator: ",")) }
            if norm(c.front).isEmpty || norm(c.back).isEmpty { flags.append("emptySide") }
            else if norm(c.back).hasSuffix(":") || c.back.split(separator: " ").count < 2 { flags.append("backStub") }
            // rule 3: fronts in question form; a bare term is rejected. Wie/Wann/Warum/Wodurch are allowed (no forced "Was ist")
            if !norm(c.front).isEmpty && !isQuestion(c.front) && !(c.front.contains("?") && c.front.split(separator: " ").count >= 5) { flags.append("frontNotQuestion") }
            // run 11 (Glidr's score): a front ending in 'wie?' with 'wie' earlier in the same front is the leaked
            // broken template ("Wie verhält sich X wie?") — always rejected; and a REVERSED front asks the answer term
            // as its subject ("Wie beeinflusst die Thermik die Intensität?" answers "die Intensität")
            if !norm(c.front).isEmpty {
              let trimmedFront = c.front.hasSuffix("?") ? String(c.front.dropLast()) : c.front
              let bodyW = norm(trimmedFront).lowercased()   // the front without its final '?'
              if has(rx(#"\bwie\?$"#), c.front) && has(rx(#"\bwie\b"#), bodyW) { flags.append("frontWieTemplate") }
              let qm = rx(#"[?？]\s*$"#).firstMatch(in: c.front, range: NSRange(c.front.startIndex..., in: c.front))
              let bodyEnd = (qm.flatMap { Range($0.range, in: c.front) }?.lowerBound) ?? c.front.endIndex
              let body = norm(String(c.front[..<bodyEnd])).lowercased()
              // run 12 fix after the first full run (16/93 frontReversed): a question about X necessarily names X —
              // "Was ist die Froudsche Zahl F?" is not reversed; only fronts that name EVERY distinguishing answer
              // word are (the frontContainsAnswerCal rule, applied to stems)
              let fw2 = stems(c.front).subtracting(qWordList.map(deStem))
              let hw2 = stems(sp.heading).subtracting(qWordList.map(deStem))
              let keyB = stems(c.back).subtracting(stems(fact.quote)).subtracting(hw2).subtracting(qWordList.map(deStem))
              let bodyStems = Set(body.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.map(deStem))
              // run 13 fix 1 (Glidr's #78): frontReversed is SKIPPED for term cards — a "Was ist <Term>?" front names the
              // answer by design; #78 Rückseitenwetter was lost to this false positive
              let reversed = keyB.count >= 3 && Double(keyB.intersection(fw2).count) / Double(keyB.count) >= 0.8 && !bodyStems.isEmpty
              if reversed && !(fact.namedTerm && isQuestion(c.front)) { flags.append("frontReversed") }
              // run 12 (Glidr's front grammar): a front without a finite verb is not a question; a dangling definite
              // article or "die Zahl" without an antecedent (#12/#13/#26) is rejected
              // a German question inverts verb-first ("Entsteht der Föhn …?"): the check accepts both orders
              // run 13 fix 1 (Glidr's #78): a TERM card's code front ("Was ist <Term>?") is the definition question — its answer
            // IS the term, so the copula-only rule must not kill it; every other front keeps the run-12 grammar bar
              let verbOk = (fact.namedTerm && !fact.term.isEmpty) || frontHasFiniteVerb(c.front) || has(frontVerbRe, abbrProtect(norm(String(c.front.components(separatedBy: " ").dropFirst().joined(separator: " ")))))
              if !verbOk { flags.append("frontNoFiniteVerb") }
              // run 13 smoke fix 2: a term card's back must ANSWER the code front — it has to name the term (on stems, so an
              // inflected form counts). The model wrote "Die Thermik benötigt …" for "Was ist Blauthermik?": that is the
              // termsLost leak of run 12 (#78 asked "Wann kann sich die Thermik verstärken?" and lost Rückseitenwetter);
              // one regeneration quotes the term verbatim, a second miss rejects the card
              let bsT = stemWords(restoreAbbr(c.back))
              let termStemsT = norm(restoreAbbr(fact.term)).split(separator: " ").map { deStem(String($0)) }
              if !termStemsT.allSatisfy { bsT.contains($0) } {
                flags.removeAll { flagKey($0) == "termsLost" }   // the term-miss is this flag now, not a keyword-list leak
                flags.append("backMissesTerm:" + norm(restoreAbbr(fact.term)))
              }
              if hasFrontDanglingAntecedent(c.front) || frontVagueSubject(c.front) { flags.append("frontDanglingAntecedent") }
            }
            // rule 6a: a truncated side ending in an ellipsis is rejected
            if norm(c.front).hasSuffix("…") || norm(c.front).hasSuffix("...") { flags.append("frontTruncated") }
            if norm(c.back).hasSuffix("…") || norm(c.back).hasSuffix("...") { flags.append("backTruncated") }
            // rule 9b: a front that contains the answer is rejected only when >=80% of the back's DISTINGUISHING
            // words (back content minus heading and question-word list) already sit in the front
            if !norm(c.front).isEmpty && !norm(c.back).isEmpty {
              let (fca, frac) = frontContainsAnswerCal(c.front, c.back, heading: sp.heading)
              // run 13 smoke fix: for a term card the code front ("Was ist <Term>?") shares its ONLY content word with the
              // back BY DESIGN — the leak check would reject every term card (Blauthermik in the smoke run); it stays hard
              // for a term card the rule is skipped; its matching side is guarded by backMissesTerm (the back must name the term)
              if fca && !(fact.namedTerm && !fact.term.isEmpty) { flags.append(String(format: "frontContainsAnswer:%.0f%%", frac * 100)) }
            }
            // rule 5: termsLost on the restricted set only (capitalised non-initial nouns, numbers with units, the named term);
            // at most one lost term, and never the named term or a number-with-unit. run 12 (Glidr's #50/#68): computed
            // against the sentence ACTUALLY USED for the back (not the whole factQuote) and matched on STEMS, so an
            // inflected form in the back ("pulsierender Thermik") counts as kept; §§ restored before comparing
            // run 14: the termsLost evaluation moved BELOW the trim step (see termsLostCheck) so a trimmed back is only held to the
            // part it kept, and front words never count as lost
            // rule 6c: a long back that faithfully quotes a named-term sentence is review, not rejection
            let faithfulQuote = fact.namedTerm && (norm(c.back).lowercased().contains(norm(fact.quote).lowercased()) || contentOverlap(c.back, fact.quote) >= 0.85)
            // run 11 (Glidr's score): backTooLong TRIMS to the sentence holding the term or a number+unit instead of
            // rejecting (#18 "etwa 0,6 °C/100 m" was rejected and lost q176); only when no sentence holds one is it a flag
            if norm(c.back).count > 350 {
              let unitReB = rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#)
              let termL = norm(fact.term).lowercased()
              let sentsB = splitSentences(norm(c.back))
              let keepIdx = sentsB.firstIndex { s in
                (!termL.isEmpty && norm(s).lowercased().contains(termL)) || has(unitReB, s) || (!fact.quote.isEmpty && contentOverlap(s, fact.quote) >= 0.5)
              }
              // run 12 (Glidr's #38/#52): a trim must keep a finite verb, else the FULL sentence stays
              if let k = keepIdx {
                let trimmed = norm(sentsB[k])
                if sentenceHasFiniteVerb(trimmed) { c.back = trimmed; flags.append("backTrimmed") }
                else { flags.append("backRevertedToFull") }
              }
              else { flags.append(faithfulQuote ? "backTooLongQuote" : "backTooLong") }
            }
            // run 12 (Glidr's #48 Totluft): a back opening with a demonstrative gets its antecedent — the previous
            // source sentence is prepended in code; when none can be found it stays a soft flag, never a hard reject
            let (pulled, didPull) = pullPrevious(c.back, secText: sp.text)
            if didPull { c.back = pulled; flags.append("backDemonstrative") }
            else if startsWithDemonstrative(c.back) { flags.append("backDemonstrative") }
            // run 14 (#39): the back's sentences follow the source order; (#25/#29) a cut parenthesis is repaired from the source
            let (ob, och) = orderBySource(c.back, secText: sp.text); if och { c.back = ob; flags.append("backReordered") }
            let (pb, pch) = balanceParens(c.back, secText: sp.text); if pch { c.back = pb; flags.append("backParensRepaired") }
            let (pf, pfch) = balanceParens(c.front, secText: sp.text); if pfch { c.front = pf }
            // run 14 (#3): a Luv back that carries the lee-side effects of another source sentence is a merge — hard (regenerate, then reject)
            if sideMerge(c.back, secText: sp.text) { flags.append("sideMerge") }
            // run 14 item 4: termsLost against the sentence(s) ACTUALLY USED for the (trimmed, pulled, ordered) back, front words kept
            do {
              let usedText = usedSentences(c.back)
              let backStemmed = stemWords(restoreAbbr(c.back + " " + c.front))
              let tl = techTerms(usedText).filter { t in !termKept(t, back: c.back + " " + c.front, backStems: backStemmed) }
              let numLike = tl.filter { $0.first?.isNumber ?? false }
              let termStems = norm(restoreAbbr(fact.term)).split(separator: " ").map { deStem(String($0)) }
              let namedLost = fact.namedTerm && !fact.term.isEmpty && !termStems.allSatisfy { backStemmed.contains($0) }
              if !flags.contains(where: { flagKey($0) == "backMissesTerm" }) && (!numLike.isEmpty || namedLost || tl.count > 1) {
                var lostList = Array(tl.prefix(6))
                if namedLost && !lostList.contains(where: { $0 == norm(fact.term).lowercased() }) { lostList.insert(norm(fact.term).lowercased(), at: 0) }
                flags.append("termsLost:" + lostList.prefix(6).joined(separator: ","))
              }
            }
            if !norm(c.back).isEmpty && norm(c.front).lowercased().contains(norm(c.back).lowercased()) { flags.append("backInFront") }
            if has(demoRe, c.front) { flags.append("frontDemonstrative") }
            // run 13 fix 7 (Glidr's #52/#54/#81): EVERY sentence of the back needs a finite verb — run 12 only checked after
            // trimming, so a pulled-in or concatenated fragment ("Albföhn der Schwäbischen Alb bei Südostwinden.") survived;
            // a term card's model-written back is held to the same bar (its code front carries "ist")
            let frags = backSentenceFragments(c.back)
            if !frags.isEmpty { flags.append("backNoFiniteVerb:" + frags.prefix(2).map { String($0.prefix(40)) }.joined(separator: "|")) }
            // run 13 fix 6 (Glidr's #8/#10/#3): the front's content nouns must appear in the back or in the fact quote —
            // #8 (Südföhn) and #10 (Nordföhn) copied #3's "…feuchtadiabatisch…Gebirge?" template, whose words sit in NEITHER
            // of their backs; a front whose nouns all sit in the quote (#78 asks Rückseitenwetter, the quote names it) is fine
            if !fact.namedTerm && frontBackMismatch(c.front, back: c.back, quote: fact.quote) { flags.append("frontBackMismatch") }
            return (c, flags)
          }
          // run 12: the two new front-grammar flags are hard; backTrimmed/backDemonstrative/backRevertedToFull are soft
          // run 13: the per-sentence verb check and the front/back mismatch are hard (one regeneration each, then reject)
          // run 13 smoke fix: a term card whose back does not name the term regenerates once, then rejects (backMissesTerm)
          let hardRegen: Set<String> = ["quoteNotVerbatim", "frontDemonstrative", "answerWordsMissing", "emptySide", "backStub", "backTooLong", "backInFront", "frontNotQuestion", "termsLost", "frontClash", "frontTruncated", "backTruncated", "frontContainsAnswer", "frontWieTemplate", "frontReversed", "frontNoFiniteVerb", "frontDanglingAntecedent", "backNoFiniteVerb", "frontBackMismatch", "backMissesTerm", "sideMerge"]
          guard var c0 = await gen(hint: nil, avoid: []) else {
            appendLine(path, line(["article": sp.article, "section": sp.no, "fact": fact.statement, "error": "generation failed"])); continue
          }
          // run 10 rule 3: fronts unique per article, but a clash means Jaccard >= 0.7 on the front stems AND the same
          // fact (statement overlap >= 0.5) — a shared topic word ("Was ist Thermik?") is NOT a duplicate any more
          var frontClash = false
          // run 11 duplicate rule (Glidr's score): (front Jaccard >= 0.7 AND back overlap >= 0.7) OR back overlap >= 0.9
          // — #3/#5 had an IDENTICAL back and different fronts, which the old AND-on-fact rule missed; the comparison is
          // on the backs of the cards (not the fact statements), so a shared topic word alone never clashes.
          // run 12 (Glidr's #1/#5 "Was entsteht der Föhn?"): a front Jaccard >= 0.9 ALWAYS clashes, whatever the back —
          // two near-identical questions are one question, even with different answers
          func dupClash(_ f: String, _ b: String) -> (String, String)? {
            for e in frontsByArticle[sp.article] ?? [] where jaccard(e.front, f) >= 0.9 || (jaccard(e.front, f) >= 0.7 && contentOverlap(e.back, b) >= 0.7) || contentOverlap(e.back, b) >= 0.9 { return (e.front, e.back) }
            return nil
          }
          if isQuestion(c0.front) {
            st.cardsCheckedForClash += 1
            let used = frontsByArticle[sp.article] ?? []
            func clashes(_ f: String) -> (String, String)? { dupClash(f, c0.back) }
            if let (cf, _) = clashes(c0.front) {
              frontClash = true; st.frontClashes += 1
              if let c2 = await gen(hint: "already asked: \(cf); ask about a different detail of the quote", avoid: used.map { $0.front }) { c0 = c2 }
            }
          }
          var (c, flags) = checks(c0); var regen = false; var first: [String] = []
          if frontClash { first.append("frontClash") }
          // a regenerated card is checked for a clash too (drop only when the SECOND attempt clashes as well)
          if !frontClash && isQuestion(c.front), let (cf, _) = dupClash(c.front, c.back) {
            frontClash = true; st.frontClashes += 1; first.append("frontClash")
            if let c2 = await gen(hint: "already asked: \(cf); ask about a different detail of the quote", avoid: (frontsByArticle[sp.article] ?? []).map { $0.front }) { regen = true; st.regenerated += 1; (c, flags) = checks(c2) }
          }
          let need = flags.map(flagKey).filter { hardRegen.contains($0) } + (frontClash ? ["frontClash"] : [])
          if !need.isEmpty {
            first = flags.isEmpty ? first : flags; for f in Set(need) { st.regenReason[f, default: 0] += 1 }
            var why = "the front must be a question ('Was…?', 'Wie…?', 'Wann…?', 'Warum…?', 'Wodurch…?') naming its subject (no bare term, no 'diese'/'solche'/'dies'), it must NOT repeat the answer (do not put the back's content words into the question), never end in '…', every noun the front asks about must also appear in the answer or in the supporting quote (a front copied from another card's wording is rejected), the quote copied exactly from the text, and the back must keep every technical term and number-with-unit of the supporting quote; EVERY sentence of the back is a complete sentence with a finite verb (no 'Bei X einen Y'-fragments) and never ends in a comma-list of keywords"
            // run 10 (Glidr's score): the lost tokens go into the keep-regeneration prompt VERBATIM, in their original
            // spelling ("Die Rückseite muss '0,6 °C pro 100 m' enthalten") — run 9 lowercased them and the number stayed lost
            // run 12: same STEM logic as the flag (against the sentence actually used; §§ restored)
            // run 13 smoke fix: a term card's back must contain the term — say so in the regeneration prompt, verbatim
            if need.contains("backMissesTerm") { why += " — Die Rückseite muss den Begriff „\(norm(restoreAbbr(fact.term)))“ wörtlich enthalten und ihn erklären (Frage: „\(termFront(fact.term))“)." }
            if need.contains("termsLost") {
              let usedT = restoreAbbr(usedSentences(c.back))
              let bs = stemWords(restoreAbbr(c.back))
              var lost = techTerms(usedT).filter { t in !termKept(t, back: c.back, backStems: bs) }
              if fact.namedTerm && !fact.term.isEmpty && !norm(restoreAbbr(fact.term)).split(separator: " ").map { deStem(String($0)) }.allSatisfy({ bs.contains($0) }) { lost.insert(fact.term, at: 0) }
              if !lost.isEmpty { why += " — Die Rückseite muss wörtlich enthalten: „" + Array(Set(lost)).joined(separator: ", ") + "“." }
            }
            if let c2 = await gen(hint: "A previous attempt (front: \(c.front)) was rejected for: \(need.joined(separator: ", ")). " + why + ".", avoid: (frontsByArticle[sp.article] ?? []).map { $0.front }) { regen = true; st.regenerated += 1; (c, flags) = checks(c2) } else { st.regenFailed += 1; flags.append("regenFailed") }
          }
          // run 14 item 6 (#81 "Wie ermöglicht Rückschlüsse auf die Thermik?", #12): a card whose BACK is fine but whose FRONT is still bad
          // after the first regeneration gets a second, targeted front attempt (the back's own nouns named in the prompt); a mismatch that
          // survives it is a SOFT flag (review) — the back was verified, so the card is no longer rejected for its front
          let frontKinds: Set<String> = ["frontBackMismatch", "frontNoFiniteVerb", "frontDanglingAntecedent", "frontNotQuestion", "frontReversed", "frontContainsAnswer", "frontTruncated", "frontWieTemplate"]
          if !(fact.namedTerm && !fact.term.isEmpty), flags.contains(where: { frontKinds.contains(flagKey($0)) }), !flags.contains(where: { hardRegen.contains(flagKey($0)) && !frontKinds.contains(flagKey($0)) }) {
            let keys = Array(techTerms(c.back).filter { !$0.first!.isNumber }.prefix(4))
            let why2 = "Your front was rejected (\(c.front)). Write a NEW question in German with a finite verb that starts with a W-word and asks about the content of the answer; it must name the subject of the answer explicitly" + (keys.isEmpty ? "" : " (key words: \(keys.joined(separator: ", ")))") + " and must not repeat the answer."
            if let c3 = await gen(hint: why2, avoid: (frontsByArticle[sp.article] ?? []).map { $0.front } + [c.front]) {
              let (cc3, ff3) = checks(c3); regen = true; st.regenerated += 1; st.regenReason["frontSecondAttempt", default: 0] += 1
              let bad3 = ff3.filter { hardRegen.contains(flagKey($0)) && !frontKinds.contains(flagKey($0)) }
              if bad3.isEmpty { c = cc3; flags = ff3 }
            }
            flags = flags.map { flagKey($0) == "frontBackMismatch" ? "frontBackMismatchSoft" : $0 }
          }
          // run 13 fix 1 (Glidr's #78): a TERM card gets its front IN CODE — "Was ist <Term>?" / "Was versteht man unter
          // <Term>?"; the model only writes the back. The template worked for Blauthermik, pulsierende Thermik and Totluft;
          // #78 was lost because the model asked an unrelated question ("Wann kann sich die Thermik wesentlich verstärken?")
          if fact.namedTerm && !fact.term.isEmpty {
            c.front = termFront(fact.term)
            flags.removeAll { flagKey($0) == "frontReversed" || flagKey($0) == "frontBackMismatch" }   // the code front is correct by construction; mismatch already skipped for term cards
            if !flags.contains(where: { flagKey($0) == "frontTermCard" }) { flags.append("frontTermCard") }
          }
          // run 13 final calibration: a term card whose back still does not name the term (the model answered from a wrong
          // sentence — #78 got the Thermikboden sentence) takes its back VERBATIM from the fact quote (previous sentence pulled
          // in for a demonstrative/pronoun start); soft flag backFromQuote, the verb/term/list flags of the model's back go
          if fact.namedTerm && !fact.term.isEmpty && flags.contains(where: { flagKey($0) == "backMissesTerm" }) {
            let (pq, _) = pullQuoteAntecedent(fact.quote, secText: sp.text)
            let qb = restoreAbbr(norm(pq)); let qs = stemWords(qb)
            let tst = norm(restoreAbbr(fact.term)).split(separator: " ").map { deStem(String($0)) }
            if tst.allSatisfy({ qs.contains($0) }) && sentenceHasFiniteVerb(qb) {
              c.back = qb
              flags.removeAll { ["backMissesTerm", "termsLost", "backNoFiniteVerb", "backDemonstrative", "backListTailStripped", "answerWordsMissing", "backTyposRestored", "backDeduped", "backInFront"].contains(flagKey($0)) }
              flags.append("backFromQuote")
            }
          }
          // after the single regeneration a still-clashing front no longer DROPS the card (run 13 fix 2, Glidr's #76):
          // a front duplicate with a UNIQUE back regenerates the front once more; only an identical BACK drops it (#42 dup of #41)
          var dropped = false
          let usedNow = frontsByArticle[sp.article] ?? []
          func clashEntry(_ f: String, _ b: String) -> (front: String, back: String)? {
            for e in usedNow where jaccard(e.front, f) >= 0.9 || (jaccard(e.front, f) >= 0.7 && contentOverlap(e.back, b) >= 0.7) || contentOverlap(e.back, b) >= 0.9 { return (e.front, e.back) }
            return nil
          }
          if let ce = clashEntry(c.front, c.back) {
            if contentOverlap(ce.back, c.back) >= 0.9 { dropped = true }   // the SAME answer twice: one card is enough
            else if fact.namedTerm && !fact.term.isEmpty { c.front = termFront(fact.term); if clashEntry(c.front, c.back) != nil { dropped = true } }
            else if let cf = await gen(hint: "your question duplicates an existing card (\(ce.front)) word for word while your answer is a DIFFERENT fact — write a clearly different front about YOUR quote", avoid: usedNow.map { $0.front }) {
              // only the FRONT is taken from that call; its back would re-run every check
              c.front = restoreAbbr(norm(cf.front)); regen = true; st.regenerated += 1; st.regenReason["frontClashRegenerated", default: 0] += 1
              // run 14 item 1 (#49/#50, #43/#44): a clash with a DIFFERENT back never drops the card — when the model's new front still
              // clashes, the front is QUALIFIED in code with a distinguishing noun of ITS OWN back ("… (Stichwort: Barriere)?")
              if let ce2 = clashEntry(c.front, c.back) {
                let otherB = stems(ce2.back), otherF = stems(ce2.front)
                let cand = rxc(#"\b[A-ZÄÖÜ][\wäöüß-]{4,}"#).matches(in: c.back, range: NSRange(c.back.startIndex..., in: c.back)).compactMap { Range($0.range, in: c.back).map { String(c.back[$0]) } }
                  .first(where: { w in !otherB.contains(deStem(w)) && !otherF.contains(deStem(w)) && !stopLower.contains(w.lowercased()) && !sentenceStartCaps.contains(w) })
                  ?? words(c.back).first(where: { w in !otherB.contains(deStem(w)) && !otherF.contains(deStem(w)) && w.count >= 6 })
                if let cw = cand {
                  let base = c.front.hasSuffix("?") ? String(c.front.dropLast()) : c.front
                  c.front = "\(base) (Stichwort: \(cw))?"; flags.append("frontClashCodeQualified")
                }
                if clashEntry(c.front, c.back) != nil { dropped = true }
              }
            } else { dropped = true }
          }
          // run 14: only cards that SURVIVE register their front — a hard-flagged or dropped card never blocks a later clean one (item 1: "keep the clean one")
          if !dropped && isQuestion(c.front) && isAccepted(flags) { frontsByArticle[sp.article, default: []].append((front: norm(c.front).lowercased(), back: norm(c.back), fact: fact.statement)) }
          let acc = isAccepted(flags) && !dropped
          st.cards += 1; if dropped { st.droppedDupFront += 1 }; if acc { st.accepted += 1; if !isClean(flags) { st.review += 1 } }
          for f in Set(flags.map(flagKey)) { st.flagCount[f, default: 0] += 1 }
          for l in logs { st.add(l, sec: secId) }
          // run 11 (Glidr's score): the ¶ label comes from WHERE THE FACT QUOTE IS FOUND in the section (paraOf on the
          // quote), not from the model — #68 said ¶20 while quoting ¶19, #3 said ¶6 while quoting ¶5
          let paraLog = paraOf(sp, quote: fact.quote, fallback: fact.statement)
          fcs.append(FC(sec: sp, fact: FactRec(statement: fact.statement, quote: fact.quote, para: paraLog.0, verbatim: fact.verbatim, guessed: paraLog.1, namedTerm: fact.namedTerm, term: fact.term), front: c.front, back: c.back, quote: c.supportingQuote, flags: flags, accepted: acc))
          appendLine(path, line(["article": sp.article, "section": sp.no, "sectionRef": "§\(sp.no)", "para": "¶\(paraLog.0)", "paraFromQuote": true, "heading": sp.heading, "fact": fact.statement, "factQuote": fact.quote,
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
    var sumPickFallbacks = 0        // run 11: sections whose pick list was invalid -> code fallback sentences taken
    var sumCoverage: [String] = []
    // run 13 fix 11 (Glidr's summary fixes): the summaries force-include on ACCEPTED TERMS, not on every technical token.
    // Key A: the source sentence of every accepted named-term capture (named-terms.jsonl) whose term an ACCEPTED card
    // carries (the run-12 rule of covered terms); Key B: every sentence with a number+unit (Föhn's "0,6 °C/100 m" was missed).
    // Both are force-included BEFORE the quota and are never dropped by the over-cap cut.
    var termSentKeys: Set<String> = []
    var keepTerms: [String] = []   // run 14: accepted terms whose parenthesis a summary bullet keeps
    if let txt = try? String(contentsOfFile: "\(out)/named-terms.jsonl", encoding: .utf8) {
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any],
              (o["accepted"] as? Bool) == true, let term = (o["term"] as? String), !term.isEmpty,
              let ar = o["article"] as? String, let se = o["section"] as? String,
              let sent = (o["sentence"] as? String) else { continue }
        // the accepted-card coverage rule of run 12 (termCovered): own card or another accepted card carrying the term
        guard fcs.contains(where: { $0.accepted && $0.sec.article == ar && $0.sec.no == se && termCovered(term, sent: sent, front: $0.front, back: $0.back) }) else { continue }
        // §§ restored: the logged sentence carries the protected form ("z§§ B§§"), the summary sentences do not
        let k = restoreAbbr(norm(sent))
        termSentKeys.insert(k)
        // the §§ form too: a source sentence taken before restoreAbbr must match as well
        termSentKeys.insert(norm(abbrProtect(k)))
        keepTerms.append(term)
      }
      // run 14 item 10: a CONDITION sentence ("überall dort, wo …", ¶65) covered by an accepted card is forced too
      for l in txt.components(separatedBy: "\n") where !l.isEmpty {
        guard let o = try? JSONSerialization.jsonObject(with: Data(l.utf8)) as? [String: Any], (o["reason"] as? String) == "condition-fact",
              let ar = o["article"] as? String, let se = o["section"] as? String, let sent = o["sentence"] as? String else { continue }
        guard fcs.contains(where: { $0.accepted && $0.sec.article == ar && $0.sec.no == se && contentOverlap($0.back, sent) >= 0.6 }) else { continue }
        let k = restoreAbbr(norm(sent)); termSentKeys.insert(k); termSentKeys.insert(norm(abbrProtect(k)))
      }
    }
    let unitReS0 = rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#)
    if modes.contains("sum") {
      let path = "\(out)/summaries.jsonl"; try? "".write(toFile: path, atomically: true, encoding: .utf8)
      let t0 = Date()
      for article in Array(Set(secs.map { $0.article })).sorted() {
        // `prot`: a forced term/number bullet — the over-cap cut must never drop it (run 13 fix 11)
        var flat: [(sec: String, text: String, order: (Int, Int), prot: Bool)] = []
        var mapMs = 0
        for sp in secs where sp.article == article {
          let secId = sp.article + "-" + sp.no
          // formula debris stripped in CODE before the map: lines that are mostly symbols/digits never reach the model
          let (cleanText, debrisLines) = stripFormulaLines(sp.text)
          sumFormulaDropped += debrisLines
          // run 11 EXTRACTIVE map: the sentences of the section are numbered and the model only picks numbers; code takes
          // the chosen sentences VERBATIM and trims parentheticals (run 10's free-rewrite map invented 4 of 12 Föhn bullets)
          // §§ restored on the offered sentences (run 13): a source sentence carries "z§§ B§§" and must never reach the
          // model or a bullet like that
          let sents = sp.paras.flatMap { splitSentences($0.text) }.map { restoreAbbr(norm($0)) }.filter { $0.split(separator: " ").count >= 5 }
          // run 12 (Glidr's score): a sentence ending in ":" is a stub and a verbless list item carries no statement —
          // neither is offered; run 13 EXAM WEIGHTING keyed on ACCEPTED TERMS: the pool holds only the sentences of accepted
          // named terms covered by an accepted card (termSentKeys) and number+unit sentences; every pool sentence is
          // FORCE-INCLUDED before the quota, the model adds AT MOST ONE free pick per section (run 12's weak picks —
          // "Die Wurzel ist verwandt mit fovere", "Ionen … elektrische Feld" — burned quota on low exam weight)
          let unitReF0 = rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#)
          func examWeighted(_ s: String) -> Bool { termSentKeys.contains(restoreAbbr(norm(s))) || termSentKeys.contains(norm(abbrProtect(norm(s)))) || has(unitReF0, s) }
          // run 14: forced sentences pass the SAME filters as picks — a lower-case start ("der „Norwegen-Föhn“ …", "der sogenannte
          // Albföhn …") is a list-item fragment, and the verb test only counts MAIN-clause verbs (sentenceHasFiniteVerb)
          let eligible = sents.filter { !$0.hasSuffix(":") && !($0.first?.isLowercase ?? true) && sentenceHasFiniteVerb($0) }
          // run 14 cap: sentences forced by an accepted TERM/condition (up to 4 per section, in text order) and sentences forced by a
          // bare NUMBER+unit (at most 2 per section) — so junk-term or number-heavy sections (§09) cannot flood the summary
          let termForced = eligible.indices.filter { termSentKeys.contains(restoreAbbr(norm(eligible[$0]))) || termSentKeys.contains(norm(abbrProtect(norm(eligible[$0])))) }
          let numForced = eligible.indices.filter { !termForced.contains($0) && has(unitReF0, eligible[$0]) }
          // run 14: the FIRST definition sentence of the article's first section ("X ist …") is always kept
          var defForced: [Int] = []
          if sp.no == (secs.filter { $0.article == sp.article }.map { $0.no }.min() ?? "") {
            if let d = eligible.indices.first(where: { has(rx(#"^[A-ZÄÖÜ][^,]{0,60}\s(?:ist|sind|wird|bezeichnet)\s"#), eligible[$0]) && eligible[$0].split(separator: " ").count >= 6 }) { defForced = [d] }
          }
          let pool = Array(Set(Array(termForced.prefix(4)) + Array(numForced.prefix(2)) + defForced)).sorted()
          // the model may pick freely over ALL eligible sentences, but only ONE of its picks survives unless it coincides
          // with a forced (term/number) sentence — that is the "at most 1 free pick" rule
          let numberedSents = eligible.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
          let offerList = eligible
          let r = await call(SectionPick.self, instructions: "You pick the sentences that summarise a textbook section. You do NOT write or rewrite any sentence: you only give the NUMBERS of the given sentences (the leading number of each line). Pick exactly ONE sentence — the single most important one of the section: prefer definitions, causes, conditions and rules over history and etymology. No references, no section numbers.",
                             prompt: "Section title: \(sp.heading)\n\nNumbered sentences of the section (the numbers run from 1 to \(offerList.count)):\n\n\(numberedSents)\n\nGive the number of the ONE sentence that best summarises this section. Do not write any text.")
          sumSt.add(CallLog(name: "mapPick", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: secId); mapMs += r.ms
          // code fallback for an invalid pick list: the term/number-carrying sentences first, then the longest ones
          let unitReF = rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#)
          func fallbackSents() -> [String] {
            // run 13: the term/number sentences rank first (same key as examWeighted), then by length
            let ranked = eligible.sorted { a, b in
              let ka = examWeighted(a) ? 1 : 0, kb = examWeighted(b) ? 1 : 0
              return (ka, a.count) > (kb, b.count)
            }
            return Array(ranked.prefix(2)).map { trimParentheticals($0, keep: keepTerms) }
          }
          // run 12: the section sentences in order with their index (for demonstrative pulls and bullet sorting)
          let orderedSents = sp.paras.flatMap { p in splitSentences(p.text).map { restoreAbbr(norm($0)) }.enumerated().map { (p.no, $0.offset, $0.element) } }
          func sentOrder(_ b: String) -> (Int, Int) {
            let t = restoreAbbr(norm(b))
            if let m = orderedSents.first(where: { restoreAbbr($0.2) == t }) { return (m.0, m.1) }
            if let m = orderedSents.first(where: { contentOverlap(restoreAbbr($0.2), t) >= 0.6 }) { return (m.0, m.1) }
            return (999, 999)
          }
          var bl: [String] = []
          if let v = r.value {
            // run 13: AT MOST ONE free model pick per section; a pick that coincides with a forced term/number sentence is
            // not counted as free (it would join the forced set anyway)
            var pickedFree = false
            for i in Array(Set(v.picks.filter { $0 >= 1 && $0 <= offerList.count })).sorted() {
              let s = trimParentheticals(offerList[i - 1], keep: keepTerms)
              if examWeighted(offerList[i - 1]) || !pickedFree { bl.append(s); if !examWeighted(offerList[i - 1]) { pickedFree = true } }
            }
            if bl.isEmpty { sumPickFallbacks += 1; bl = fallbackSents() }
          } else { sumSt.errors += 1; sumPickFallbacks += 1; bl = fallbackSents() }
          // run 13 EXAM WEIGHTING (before the quota): force-include every eligible sentence carrying an ACCEPTED named term
          // or a number+unit; forced bullets are PROTECTED — the over-cap cut and the support check never drop them (#11)
          var protectedBullets = Set<String>()
          let forced = Array(Set(pool.map { trimParentheticals(eligible[$0], keep: keepTerms) }))
          for f in forced { protectedBullets.insert(f) }
          for f in forced where !bl.contains(where: { contentOverlap($0, f) >= 0.7 }) { bl.append(f) }
          // a picked sentence that still carries formula debris or source-number debris is dropped/stripped in code
          var kept: [String] = []
          for b in bl { let (s, ch) = stripDebris(b); if !s.isEmpty { kept.append(s); if ch { sumDebrisStripped += 1 } } else { sumFormulaDropped += 1 } }
          bl = kept
          // run 12 (Glidr's summary fixes): a bullet opening with a demonstrative pulls its previous source sentence;
          // ":"-stubs and verbless lines never become bullets; " ," / " ." debris collapsed; §§ restored
          var fixed: [String] = []
          for b in bl {
            let r1 = restoreAbbr(b)
            if r1.hasSuffix(":") || !sentenceHasFiniteVerb(r1) { continue }
            let (pulled, _) = pullPrevious(r1, secText: sp.text)
            let cleaned = cleanSpacing(pulled)
            if cleaned.split(separator: " ").count >= 4 && !fixed.contains(where: { contentOverlap($0, cleaned) >= 0.7 }) { fixed.append(cleaned) }
          }
          bl = fixed.sorted { sentOrder($0) < sentOrder($1) }
          let pw = Set(words(cleanText)); var low = 0
          for b in bl { let kw = words(b); if !kw.isEmpty && Double(kw.filter { !pw.contains($0) }.count) / Double(kw.count) > 0.5 { low += 1 } }
          // run 10 spec 3a support check kept: on an EXTRACTIVE map every bullet is a source sentence so it always
          // passes; the check stays as a guard (and still guards the code-fallback sentences)
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
          // run 13: a FORCED (term/number) bullet is never dropped by the support/causal check — it is a verbatim source
          // sentence carrying an exam term; only free picks pass the guard
          bl = bl.filter { b in
            if protectedBullets.contains(where: { contentOverlap($0, b) >= 0.7 }) { return true }
            if !techSupported(b) { supDroppedHere += 1; return false }
            if has(causalRe, b) && !secSents.contains(where: { has(causalRe, $0) && contentOverlap($0, b) >= 0.35 }) { supDroppedHere += 1; return false }
            return true
          }
          sumBulletsUnsupported += supDroppedHere
          sumBullets += bl.count; sumBulletsLow += low
          // run 12: the sort key of each bullet (paragraph, sentence) rides along so the final list orders by § and
          // sentence index; added coverage fallbacks get (999,999) and land last
          for b in bl { flat.append((sp.no, b, sentOrder(b), protectedBullets.contains(where: { contentOverlap($0, b) >= 0.7 }))) }   // the bullet keeps its own section id (§NN), never a chunk index
          appendLine(path, line(["stage": "map", "article": article, "section": sp.no, "sectionRef": "§\(sp.no)", "history": sp.history, "bullets": bl.map { $0 + " (§\(sp.no))" }, "lowOverlapBullets": low,
                                 "extractive": true, "sentencesOffered": sents.count, "picksRaw": (r.value?.picks ?? []).map { String($0) }, "pickFallback": sumPickFallbacks,
                                 "formulaLinesStrippedBeforeMap": debrisLines,
                                 "ms": r.ms, "tokens": ["in": r.tokensIn, "out": r.tokensOut], "error": r.error ?? NSNull()]))
          say("sum map \(secId) \(bl.count) bullets \(r.ms) ms")
        }
        let numbered = flat.enumerated().map { "\($0.offset + 1). \($0.element.text)" }.joined(separator: "\n")
        // the combine step does NOT rewrite: it picks input bullet numbers and orders them; texts stay verbatim
        // run 10 spec 3b: the quota is stated to the model (every section at least once, always keep a bullet with a
        // named term or a number+unit); invalid picks are logged with their raw sources and the reason why they failed
        let insC = "You order section summaries into one article summary. You do NOT rewrite, merge or rephrase any bullet: for every output bullet give exactly ONE number of an input bullet (the leading number of the line), and the text you repeat is ignored (the code keeps the input bullet word for word). Choose 6 to 10 bullets that cover the whole article: spread your choices over the whole list, not only its start; always keep a bullet that contains a technical term or a number with a unit; skip redundant ones, order them by topic."
        // run 13: the combine prompt says it too (the code enforces it anyway): forced bullets are kept, one free pick max
        let r = await call(Combined.self, instructions: insC, prompt: "Article \(article). Numbered section bullets (the numbers run from 1 to \(flat.count)):\n\n\(numbered)\n\nChoose 6 to 10 of these bullets that together cover the whole article without repeating each other, in a sensible order. Spread the choices over the whole list; prefer bullets carrying a technical term or a number with unit. For every chosen bullet give its input line number (exactly one per output bullet). Do not write any text. Note: most of these bullets are forced exam-relevant ones and are kept automatically — your numbers only add at most one further bullet.")
        sumSt.add(CallLog(name: "combine", ms: r.ms, tin: r.tokensIn, tout: r.tokensOut), sec: article + "-combine")
        struct Item { var text: String; var secs: Set<String>; var added: Bool; var order: (Int, Int) = (999, 999); var prot: Bool = false }
        // run 13 fix 11: the combine step may only CHOOSE among the forced term/number bullets and at most ONE free pick —
        // so a Thermik/Föhn summary can never end up without its exam sentences; coverage fallbacks join afterwards,
        // BEFORE the quota (run 12 added them after the cut and still missed Cumulus/Blauthermik/Schichtung/Rückseitenwetter)
        var must = flat.filter { $0.prot }.map { Item(text: $0.text, secs: [$0.sec], added: false, order: $0.order, prot: true) }
        var seenMust = Set<String>()
        must = must.filter { if seenMust.contains($0.text) { return false }; seenMust.insert($0.text); return true }
        var picked: [Item] = []; var bad = 0; var pickLogs: [PickLog] = []
        if let v = r.value {
          for it in v.items {
            let raw = it.sources.map(String.init).joined(separator: ",")
            let srcs = Array(Set(it.sources.filter { $0 >= 1 && $0 <= flat.count }))
            guard srcs.count == 1 else { bad += 1; pickLogs.append(PickLog(raw: raw, ok: false, why: it.sources.isEmpty ? "no source given" : "not exactly one valid input number (got [\(raw)], \(it.sources.count) values)")); continue }   // one input bullet per output item, its own §id
            let idx = srcs[0] - 1
            if flat[idx].prot { pickLogs.append(PickLog(raw: raw, ok: true, why: "forced term/number bullet \(srcs[0]) §\(flat[idx].sec) — kept by code")); continue }   // forced bullets are in `must` already
            if must.contains(where: { contentOverlap($0.text, flat[idx].text) >= 0.7 }) || picked.contains(where: { $0.text == flat[idx].text }) { pickLogs.append(PickLog(raw: raw, ok: false, why: "already covered by a forced bullet")); continue }
            if !picked.isEmpty { pickLogs.append(PickLog(raw: raw, ok: false, why: "free-pick cap (1 per article) already used")); continue }
            picked.append(Item(text: flat[idx].text, secs: [flat[idx].sec], added: false, order: flat[idx].order))
            pickLogs.append(PickLog(raw: raw, ok: true, why: "bullet \(srcs[0]) §\(flat[idx].sec)"))
          }
        } else { sumSt.errors += 1 }
        // the forced bullets join BEFORE the quota; a free pick that duplicates one is dropped
        for m in must where !picked.contains(where: { contentOverlap($0.text, m.text) >= 0.7 }) { picked.append(m) }
        // code dedup at >=70% content-word overlap (later one dropped, its section joined to the earlier)
        var dedup: [Item] = []; var dups = 0
        for it in picked {
          if let k = dedup.firstIndex(where: { contentOverlap($0.text, it.text) >= 0.7 }) {
            dedup[k].secs.formUnion(it.secs); dedup[k].prot = dedup[k].prot || it.prot; dups += 1
          } else { dedup.append(it) }
        }
        // run 10 spec 3b quota: every non-history section without a bullet adds its FIRST supported map bullet that
        // carries a named term or a number+unit (falls back to the first bullet of the section); then, over the cap,
        // unsupported bullets are dropped before any bullet carrying a named term/number+unit is ever dropped
        let unitRe = rx(#"\d+(?:[.,]\d+)?\s*(?:°C|K|km|m|s|min|h|%|Pa|hPa|kJ/kg|kg|l/min|g/l|g/kg|°|/100\s*m|je 100 m)"#)
        func carriesTech(_ b: String) -> Bool { !techTerms(b).isEmpty || has(unitRe, b) }
        var added = 0
        for sp in secs where sp.article == article && !sp.history {
          if !dedup.contains(where: { $0.secs.contains(sp.no) }) {
            // run 11 quota keep-rule: a fallback bullet carries a named term or a number+unit whenever the section has
            // one; only a section whose supported sentences hold no term/number falls back to its first (generic) bullet
            let secB = flat.filter { $0.sec == sp.no }
            // run 13: a fallback bullet prefers the section's FORCED term/number sentence, then any term/number bullet
            let cand = secB.first(where: { $0.prot }) ?? secB.first(where: { carriesTech($0.text) }) ?? secB.first
            if let f = cand {
              if dedup.contains(where: { contentOverlap($0.text, f.text) >= 0.7 }) { dups += 1; continue }
              let prot = flat.first(where: { $0.sec == sp.no && $0.text == f.text })?.prot ?? false
              dedup.append(Item(text: f.text, secs: [sp.no], added: true, order: flat.first(where: { $0.sec == sp.no && $0.text == f.text })?.order ?? (999, 999), prot: prot)); added += 1
            }
          }
        }
        // run 13: the over-cap cut drops FREE picks first, then non-forced added bullets — a FORCED term/number bullet is
        // never dropped (run 12's quota let Thermik end without any exam-term sentence)
        if dedup.count > 10 {
          var over = 0
          dedup = dedup.filter { it in
            if dedup.count - over <= 10 { return true }
            if it.prot { return true }
            if !it.added || !carriesTech(it.text) { over += 1; return false }
            return true
          }
        }
        sumDup += dups; sumAdded += added; sumRefIssues += bad
        // run 12 (Glidr's order fix): bullets sorted by section number and sentence index, not by the model's order
        func ordKey(_ it: Item) -> [Int] { [(it.secs.min() ?? "99").flatMap { Int($0) } ?? 99, it.order.0, it.order.1] }
        let ordered = dedup.sorted { a, b in
          let ka = ordKey(a), kb = ordKey(b)
          for i in 0..<ka.count where ka[i] != kb[i] { return ka[i] < kb[i] }
          return false
        }
        let outB = ordered.map { $0.text + " (" + $0.secs.sorted().map { "§\($0)" }.joined(separator: ", ") + ")" }
        let cited = Set(ordered.flatMap { $0.secs })
        let nonHist = secs.filter { $0.article == article && !$0.history }.map { $0.no }
        let rawCount = r.value?.items.count ?? 0
        sumCoverage.append("\(article): non-history sections covered \(nonHist.filter { cited.contains($0) }.count)/\(nonHist.count); combine picked \(rawCount) -> valid \(picked.count) - dedup \(dups) + coverage fallbacks \(added) = \(dedup.count); invalid picks (not exactly one input bullet) \(bad); all texts verbatim map output; raw combine output in this line's 'combineRawItems'")
        appendLine(path, line(["stage": "combine", "article": article, "bullets": outB, "bulletCount": outB.count, "combinedRaw": rawCount, "validPicks": picked.count, "duplicatesMerged": dups, "addedForCoverage": added,
                               "invalidPicks": bad, "verbatimRewrites": 0,
                               // run 10: the raw pick list with the validation reason per pick (run 9's Föhn combine gave
                               // 6 picks and all failed srcs.count == 1 — this log shows what the model returned)
                               "combineRawItems": pickLogs.map { ["sources": $0.raw, "ok": $0.ok, "why": $0.why] },
                               "addedBullets": ordered.filter { $0.added }.map { $0.text }, "bulletsWithoutValidSource": bad, "inputBullets": flat.count,
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
      // run 11 row labels come from the dir name (".../run10/" -> "run 10"), not from a 6+ri counter (the old label
      // mislabelled run 9 and run 10 dirs as "run 8"/"run 9"); runs 6-7 keep their correct numbers
      let dirDigits = prev.split(separator: "/").filter { $0.hasPrefix("run") }.last.map { $0.dropFirst(3) } ?? ""
      let rowName = Int(dirDigits).map { "run \($0)" } ?? "run \(6 + ri)"
      rowsCmp.append(RunRow(name: rowName, cards: cards.count, accepted: accCards.count,
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
      // run 11: the named-term column counts Föhnkrankheit too (it was already in targetTerms; the header says so)
      cmpMd = "\n## comparison table (runs measured on the same sections; tokens per accepted card = in+out of that card's calls; the named-term column includes Föhnkrankheit)\n\n| run | cards | accepted % | tokens per accepted card | paragraphs > 60 w covered | named-term hits incl. Föhnkrankheit (in accepted front/back) |\n|---|---|---|---|---|---|\n"
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
      - duplicate fronts (run 11 rule: (Jaccard >= 0.7 on the front AND back overlap >= 0.7) OR back overlap >= 0.9): clashes detected \(pct(s.frontClashes, s.cardsCheckedForClash)) of cards checked; run 9's min-overlap rule dropped 23/84 (frontClash 27 first-attempt defects)
      - flag rates (share of cards; a card can carry several):
      \(rates.isEmpty ? "  - none" : rates)
      - regenerated: \(s.regenerated), regeneration failed: \(s.regenFailed); first-attempt defects by reason: \(reg.isEmpty ? "none" : reg)
      - median ms per call: \(calls)
      - ms per section: mean \(secMsAll.isEmpty ? 0 : secMsAll.reduce(0, +) / secMsAll.count), median \(median(secMsAll)), total wall \(s.wallMs) ms (per-section list in timing-sections.json)
      - tokens (in/out): \(s.tokIn)/\(s.tokOut); per accepted card (in+out): \(tpa)
      - ms per accepted card: \(s.accepted == 0 ? "n/a" : "\(s.secMs.values.reduce(0, +) / s.accepted)")
      """
    }
    var md = "# pipeline summary (run 14, \(lang))\n\n- input: \(input) (\(secs.count) sections: \(Set(secs.map { $0.article }).sorted().joined(separator: ", "))); modes: \(modes.joined(separator: ",")); MCQ not run (opt-in)\n" + cmpMd + "\n"
    if let s = report["flash"] { md += block("9a/9b flashcards", s) + "\n" + termMd + "\n" }
    md += "## coverage per paragraph (cards from the paragraph / paragraphs over 60 words)\n\n" + covMd + r6Cov
    if report["sum"] != nil {
      let s = sumSt
      md += "## 9c summaries (run 14: EXTRACTIVE map — the model picks numbered source sentences, code takes them verbatim and trims parentheticals; EXAM WEIGHTING keyed on ACCEPTED TERMS: force-include, BEFORE the quota, every sentence of an accepted named term covered by an accepted card plus every number+unit sentence (never dropped by the over-cap cut), then AT MOST 1 free model pick per section and at most 1 per article at combine; demonstrative picks pull the previous sentence; \":-stubs and verbless lines dropped; \" ,\"/\" .\" collapsed; §§ restored; bullets sorted by § and sentence index; quota >= 1 bullet per non-history section; verbatim combine as run 8)\n\n- map (pick) calls: \(s.perCall["mapPick"]?.count ?? 0), median ms \(median(s.perCall["mapPick"] ?? [])); invalid pick lists falling back to code-picked sentences: \(sumPickFallbacks); combine calls: \(s.perCall["combine"]?.count ?? 0), median ms \(median(s.perCall["combine"] ?? []))\n- section bullets (verbatim source sentences, parentheticals trimmed): \(sumBullets), with >50% content words missing from the section: \(sumBulletsLow); dropped by the support/causal check: \(sumBulletsUnsupported)\n- formula-debris lines stripped in code BEFORE the map: \(sumFormulaDropped); formula-debris bullets dropped after the map / source numbers \"(1, 3, 4)\" stripped in: \(sumDebrisStripped)\n- combine picks invalid (not exactly one input bullet): \(sumRefIssues); near-duplicate bullets merged in code (>=70% overlap): \(sumDup); coverage fallbacks added (verbatim map bullet of an uncovered section): \(sumAdded)\n- " + sumCoverage.joined(separator: "\n- ") + "\n- tokens (in/out): \(s.tokIn)/\(s.tokOut); total wall \(s.wallMs) ms; call errors \(s.errors)\n- ms per section (map): " + s.secMs.filter { !$0.key.hasSuffix("combine") }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", ") + "\n\n"
    }
    var timing: [String: Any] = [:]
    for (k, s) in report { timing[k] = s.secMs.mapValues { $0 }.merging(s.secTok.reduce(into: [String: Int]()) { $0[$1.key + ".tokIn"] = $1.value.0; $0[$1.key + ".tokOut"] = $1.value.1 }) { a, _ in a } }
    if let d = try? JSONSerialization.data(withJSONObject: timing, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: out + "/timing-sections.json")) }
    try? md.write(toFile: out + "/summary.md", atomically: true, encoding: .utf8)
    say(md)
  }
}
