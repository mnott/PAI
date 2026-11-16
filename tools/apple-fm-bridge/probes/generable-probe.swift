// Probe: FoundationModels @Generable guided generation for study-question extraction.
// Build: pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/generable-probe.swift -o $TMPDIR/generable-probe
// Run:   $TMPDIR/generable-probe /tmp/cl-ai/sample-p3-4.txt /tmp/cl-ai
import Foundation
import FoundationModels

@Generable struct Summary: Codable {
  @Guide(description: "one-sentence gist of the whole text") var gist: String
  @Guide(description: "5 key facts, each one taken from the text", .count(5)) var bullets: [String]
}
@Generable struct SingleChoice: Codable {
  @Guide(description: "a question that must need the text to answer, not general knowledge") var question: String
  @Guide(description: "the one correct answer according to the text") var correct: String
  @Guide(description: "wrong answers that are plausible but wrong per the text", .count(3)) var distractors: [String]
  @Guide(description: "why the correct answer is right, per the text") var explanation: String
  @Guide(description: "sourceQuote verbatim from the text: one exact contiguous sentence copied character for character") var sourceQuote: String
}
@Generable struct FreeQ: Codable {
  @Guide(description: "an open question that must need the text to answer") var question: String
  @Guide(description: "short model answer based on the text") var answer: String
  @Guide(description: "why this answer is right, per the text") var explanation: String
  @Guide(description: "sourceQuote verbatim from the text: one exact contiguous sentence copied character for character") var sourceQuote: String
}
@Generable struct TrueFalse: Codable {
  @Guide(description: "a statement about the text that is clearly true or clearly false per the text") var statement: String
  var isTrue: Bool
  @Guide(description: "why, per the text") var explanation: String
  @Guide(description: "sourceQuote verbatim from the text: one exact contiguous sentence copied character for character") var sourceQuote: String
}
@Generable struct Cloze: Codable {
  @Guide(description: "a sentence from the text with one key term replaced by ____; must need the text to fill in") var sentenceWithBlank: String
  @Guide(description: "the exact term that fills the blank") var answer: String
  @Guide(description: "sourceQuote verbatim from the text: the complete original sentence") var sourceQuote: String
}
@Generable struct QuestionSet: Codable {
  @Guide(.count(2)) var singleChoice: [SingleChoice]
  @Guide(.count(2)) var free: [FreeQ]
  @Guide(.count(1)) var trueFalse: [TrueFalse]
  @Guide(.count(1)) var cloze: [Cloze]
}
@Generable struct SCList: Codable { @Guide(.count(2)) var items: [SingleChoice] }
@Generable struct FreeList: Codable { @Guide(.count(2)) var items: [FreeQ] }
@Generable struct TFList: Codable { @Guide(.count(1)) var items: [TrueFalse] }
@Generable struct ClozeList: Codable { @Guide(.count(1)) var items: [Cloze] }

let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
let enc: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]; return e }()

struct Run { var name: String; var secs: Double; var promptTokens: Int; var outTokens: Int; var json: String; var error: String? }

func gen<T: Generable & Encodable>(_ type: T.Type, instructions: String, prompt: String) async -> (T?, Double, Int, Int, String?) {
  let t0 = Date()
  var pt = 0
  do {
    pt = try await model.tokenCount(for: Instructions(instructions)) + model.tokenCount(for: Prompt(prompt))
  } catch { pt = -1 }
  do {
    let s = LanguageModelSession(model: model, instructions: instructions)
    var o = GenerationOptions(); o.maximumResponseTokens = 3000
    let r = try await s.respond(to: prompt, generating: type, options: o)
    let dt = Date().timeIntervalSince(t0)
    let j = String(data: try enc.encode(r.content), encoding: .utf8) ?? ""
    let ot = (try? await model.tokenCount(for: j)) ?? -1
    return (r.content, dt, pt, ot, nil)
  } catch {
    return (nil, Date().timeIntervalSince(t0), pt, 0, "\(error)")
  }
}

func write(_ path: String, title: String, secs: Double, pt: Int, ot: Int, json: String, error: String?, note: String = "") {
  var s = "# \(title)\n\n- time: \(String(format: "%.1f", secs)) s\n- input: \(pt) tokens (model.tokenCount: instructions + prompt)\n- output: \(ot) tokens (model.tokenCount of the encoded JSON; the response exposes no usage)\n"
  if !note.isEmpty { s += "- \(note)\n" }
  if let e = error { s += "- ERROR: \(e)\n" }
  s += "\n```json\n\(json)\n```\n"
  try? s.write(toFile: path, atomically: true, encoding: .utf8)
  print("wrote \(path): \(secs)s in=\(pt) out=\(ot) err=\(error ?? "-")")
}

@main struct Probe {
  static func main() async {
    let args = CommandLine.arguments
    let text = try! String(contentsOfFile: args[1], encoding: .utf8)
    let dir = args[2]
    let prompt = "Text:\n\n\(text)"
    let baseEN = "You write study material from the given text only. Every question must need the text to answer. Every sourceQuote must be copied verbatim from the text."
    let baseDE = baseEN + " Write all questions, answers, distractors and explanations in German; keep sourceQuote in the original English wording of the text."

    // A
    let a = await gen(Summary.self, instructions: "You summarise the given text faithfully. Use only facts stated in the text.", prompt: prompt)
    write("\(dir)/fm-generable-summary.md", title: "generable summary", secs: a.1, pt: a.2, ot: a.3,
          json: a.0.flatMap { String(data: try! enc.encode($0), encoding: .utf8) } ?? "", error: a.4)
    // B
    let b = await gen(QuestionSet.self, instructions: baseEN, prompt: prompt + "\n\nWrite the question set.")
    write("\(dir)/fm-generable-questions-en.md", title: "generable questions en (single call)", secs: b.1, pt: b.2, ot: b.3,
          json: b.0.flatMap { String(data: try! enc.encode($0), encoding: .utf8) } ?? "", error: b.4)
    // C
    let c = await gen(QuestionSet.self, instructions: baseDE, prompt: prompt + "\n\nWrite the question set in German.")
    write("\(dir)/fm-generable-questions-de.md", title: "generable questions de (single call)", secs: c.1, pt: c.2, ot: c.3,
          json: c.0.flatMap { String(data: try! enc.encode($0), encoding: .utf8) } ?? "", error: c.4)
    // D
    let p = prompt + "\n\nWrite the questions."
    let d1 = await gen(SCList.self, instructions: baseEN, prompt: p)
    let d2 = await gen(FreeList.self, instructions: baseEN, prompt: p)
    let d3 = await gen(TFList.self, instructions: baseEN, prompt: p)
    let d4 = await gen(ClozeList.self, instructions: baseEN, prompt: p)
    func js<T: Encodable>(_ v: T?) -> String { v.flatMap { String(data: try! enc.encode($0), encoding: .utf8) } ?? "null" }
    let json = "{\n\"singleChoice\": \(js(d1.0)),\n\"free\": \(js(d2.0)),\n\"trueFalse\": \(js(d3.0)),\n\"cloze\": \(js(d4.0))\n}"
    let errs = [d1.4, d2.4, d3.4, d4.4].compactMap { $0 }.joined(separator: "; ")
    write("\(dir)/fm-generable-questions-en-4calls.md", title: "generable questions en (4 calls, one per type)",
          secs: d1.1 + d2.1 + d3.1 + d4.1, pt: d1.2 + d2.2 + d3.2 + d4.2, ot: d1.3 + d2.3 + d3.3 + d4.3, json: json,
          error: errs.isEmpty ? nil : errs,
          note: String(format: "per call s: %.1f / %.1f / %.1f / %.1f; tokens in: %d/%d/%d/%d out: %d/%d/%d/%d", d1.1, d2.1, d3.1, d4.1, d1.2, d2.2, d3.2, d4.2, d1.3, d2.3, d3.3, d4.3))
  }
}
