// apple-fm-bridge — a headless localhost HTTP bridge exposing Apple's
// on-device model (FoundationModels / SystemLanguageModel) behind the
// Anthropic Messages API subset, so PAI worker providers can name it.
//
// Serves 127.0.0.1 only (default port 8037, override with $APPLE_FM_PORT).
//   GET  /v1/models      one id: "apple-fm"
//   POST /v1/messages    Anthropic Messages subset: system + messages
//                        (string or text-block content), streaming SSE and
//                        non-streaming. Tool definitions are accepted; the
//                        model is instructed to answer with ONE JSON object
//                        {"tool": ..., "input": ...}, which the bridge turns
//                        into an Anthropic tool_use block (stop_reason
//                        "tool_use"). Structured tool calls need stream:false
//                        (a streaming reply cannot be rewritten after it was
//                        sent as text).
// Over-limit requests answer 400 naming the context limit.
//
// MIT licensed; no personal data; Foundation + Network only.

import Foundation
import FoundationModels
import Network

let MODEL_ID = "apple-fm"

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func jsonOut(_ v: Any) -> Data {
  (try? JSONSerialization.data(withJSONObject: v)) ?? Data("{}".utf8)
}

func apiError(_ status: Int, _ type: String, _ message: String) -> Data {
  jsonOut(["error": ["type": type, "message": message]])
}

/// Anthropic content blocks (text / tool_use / tool_result) → plain text.
func blocksToText(_ content: Any) -> String {
  if let s = content as? String { return s }
  guard let blocks = content as? [[String: Any]] else { return "" }
  var parts: [String] = []
  for b in blocks {
    switch b["type"] as? String {
    case "text":
      if let t = b["text"] as? String { parts.append(t) }
    case "tool_result":
      let inner = b["content"].map(blocksToText) ?? ""
      parts.append("[tool_result] \(inner)")
    case "tool_use":
      let name = (b["name"] as? String) ?? "?"
      let inp: String
      if let obj = b["input"] as? [String: Any], let d = try? JSONSerialization.data(withJSONObject: obj) {
        inp = String(data: d, encoding: .utf8) ?? "{}"
      } else { inp = "{}" }
      parts.append("[tool_use \(name)] \(inp)")
    default:
      break
    }
  }
  return parts.joined(separator: "\n")
}

// ---------------------------------------------------------------------------
// Anthropic request → FoundationModels transcript
// ---------------------------------------------------------------------------

struct FMRequest {
  var instructions: String?
  var entries: [Transcript.Entry] = []   // alternating prompt/response history, ending with a prompt
  var maxTokens: Int?
  var temperature: Double?
  var tools: [[String: Any]]             // anthropic tool defs
  var lastPrompt = Prompt("")            // the final user turn, for streamResponse(to:)
}

struct RequestError: Error { let status: Int; let type: String; let message: String }

func parseRequest(_ body: [String: Any]) throws -> FMRequest {
  guard let rawMessages = body["messages"] as? [[String: Any]] else {
    throw RequestError(status: 400, type: "invalid_request_error", message: "messages: required array")
  }
  let sysText = body["system"].map(blocksToText) ?? ""
  var req = FMRequest(instructions: sysText.isEmpty ? nil : sysText,
                      maxTokens: body["max_tokens"] as? Int,
                      temperature: body["temperature"] as? Double,
                      tools: (body["tools"] as? [[String: Any]]) ?? [])
  var lastUserText = ""
  for m in rawMessages {
    let role = (m["role"] as? String) ?? "user"
    let text = blocksToText(m["content"] ?? "")
    if role == "assistant" {
      req.entries.append(.response(Transcript.Response(segments: [.text(.init(content: text))])))
    } else {
      // Anthropic puts tool_result blocks in a user message; keep the turn order.
      req.entries.append(.prompt(Transcript.Prompt(segments: text.isEmpty ? [] : [.text(.init(content: text))])))
      lastUserText = text
    }
  }
  req.lastPrompt = Prompt(lastUserText)
  if req.entries.isEmpty { throw RequestError(status: 400, type: "invalid_request_error", message: "messages: no usable content") }
  return req
}

/// The tool-advertisement line appended to instructions when tools are present.
func toolAdvert(_ tools: [[String: Any]]) -> String? {
  guard !tools.isEmpty else { return nil }
  var lines: [String] = []
  for t in tools {
    let name = (t["name"] as? String) ?? "?"
    let desc = (t["description"] as? String) ?? ""
    var schema = "{}"
    if let obj = t["input_schema"] as? [String: Any], let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) { schema = s }
    lines.append("- \(name): \(desc) input JSON schema: \(schema)")
  }
  return "You may call one tool per reply. To call a tool, output ONLY one JSON object of the form {\"tool\": \"<name>\", \"input\": <json matching its schema>} and nothing else. Otherwise answer normally in text.\nTools:\n" + lines.joined(separator: "\n")
}

/// Try to read a {"tool": ..., "input": ...} JSON call out of model text.
func parseToolCall(_ text: String, allowed: Set<String>) -> (name: String, input: [String: Any])? {
  guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}") else { return nil }
  let slice = String(text[start...end])
  guard let data = slice.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let name = obj["tool"] as? String, allowed.contains(name) else { return nil }
  return (name, (obj["input"] as? [String: Any]) ?? [:])
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

let model = SystemLanguageModel.default

func checkAvailable() throws {
  switch model.availability {
  case .available: return
  case .unavailable(let r):
    let why: String
    switch r {
    case .deviceNotEligible: why = "device not eligible for Apple Intelligence"
    case .appleIntelligenceNotEnabled: why = "Apple Intelligence is not enabled (System Settings > Apple Intelligence & Siri)"
    case .modelNotReady: why = "the on-device model is not ready yet (still downloading/processing)"
    @unknown default: why = "\(r)"
    }
    throw RequestError(status: 503, type: "unavailable_error", message: "apple-fm unavailable: \(why)")
  @unknown default:
    throw RequestError(status: 503, type: "unavailable_error", message: "apple-fm availability unknown")
  }
}

/// Token count of the whole request (instructions + history + tool advert),
/// refusing when it does not fit the model context; returns the response room.
func guardContext(_ req: FMRequest) async throws -> Int {
  var instr = req.instructions ?? ""
  if let adv = toolAdvert(req.tools) { instr += (instr.isEmpty ? "" : "\n\n") + adv }
  var n = 0
  if !instr.isEmpty { n += try await model.tokenCount(for: Instructions(instr)) }
  n += try await model.tokenCount(for: req.entries)
  let ctx = model.contextSize
  let want = min(req.maxTokens ?? 1024, 2048)
  FileHandle.standardError.write(Data("apple-fm-bridge: prompt \(n) tokens of \(ctx), tools \(req.tools.count), max_tokens \(req.maxTokens ?? -1)\n".utf8))
  if n + 64 > ctx {
    throw RequestError(status: 400, type: "invalid_request_error",
      message: "request exceeds the apple-fm context limit: prompt is \(n) tokens, model context is \(ctx) tokens (FoundationModels SystemLanguageModel). Shorten the conversation.")
  }
  return min(want, ctx - n)
}

/// The instructions entry (system text + tool advert), or nil.
func instructionsEntry(_ req: FMRequest) -> Transcript.Entry? {
  var instr = req.instructions ?? ""
  if let adv = toolAdvert(req.tools) { instr += (instr.isEmpty ? "" : "\n\n") + adv }
  guard !instr.isEmpty else { return nil }
  return .instructions(Transcript.Instructions(segments: [.text(.init(content: instr))], toolDefinitions: []))
}

/// History WITHOUT the final prompt turn (that one goes to streamResponse(to:)).
func history(_ req: FMRequest) -> [Transcript.Entry] {
  var entries = req.entries
  if case .prompt = entries.last { entries.removeLast() }
  return entries
}

/// One generation. Returns full text; onDelta(textDelta) is called per snapshot delta when given.
func generate(_ req: FMRequest, maxTokens: Int, onDelta: ((String) -> Void)?) async throws -> String {
  var options = GenerationOptions()
  options.maximumResponseTokens = maxTokens
  if let t = req.temperature { options.temperature = t }
  var entries = history(req)
  if let instr = instructionsEntry(req) { entries.insert(instr, at: 0) }
  let s = LanguageModelSession(model: model, transcript: Transcript(entries: entries))
  var out = ""
  for try await snap in s.streamResponse(to: req.lastPrompt) {
    let full = snap.content
    if full.count > out.count {
      let delta = String(full.dropFirst(out.count))
      out = full
      onDelta?(delta)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// HTTP server (Network.framework, loopback only)
// ---------------------------------------------------------------------------

let portVal = UInt16(ProcessInfo.processInfo.environment["APPLE_FM_PORT"] ?? "8037") ?? 8037

final class Buf: @unchecked Sendable { var data = Data() }

func makeParams() -> NWParameters {
  let p = NWParameters.tcp
  p.allowLocalEndpointReuse = true
  return p
}

struct HTTPRequest { let method: String; let path: String; let body: Data }

func readHTTPRequest(_ conn: NWConnection, onDone: @escaping @Sendable (HTTPRequest?) -> Void) {
  let buf = Buf()
  func step() {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
      if let d = data { buf.data.append(d) }
      if error != nil { onDone(nil); return }
      guard let headEnd = buf.data.range(of: Data("\r\n\r\n".utf8)) else {
        if isComplete { onDone(nil) } else { step() }
        return
      }
      let head = String(data: buf.data[buf.data.startIndex..<headEnd.lowerBound], encoding: .utf8) ?? ""
      let lines = head.components(separatedBy: "\r\n")
      let parts = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: true)
      guard parts.count >= 2 else { onDone(nil); return }
      let method = String(parts[0]), path = String(parts[1])
      var contentLength = 0
      for l in lines.dropFirst() where l.lowercased().hasPrefix("content-length:") {
        contentLength = Int(l.split(separator: ":").last.map { $0.trimmingCharacters(in: .whitespaces) } ?? "0") ?? 0
      }
      let bodyStart = buf.data.index(buf.data.startIndex, offsetBy: headEnd.upperBound - buf.data.startIndex)
      func done() { onDone(HTTPRequest(method: method, path: path, body: buf.data[bodyStart..<min(buf.data.endIndex, bodyStart + contentLength)])) }
      if buf.data.endIndex - bodyStart >= contentLength { done(); return }
      func fill() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { d2, _, done2, err2 in
          if let d = d2 { buf.data.append(d) }
          if buf.data.endIndex - bodyStart >= contentLength || err2 != nil || done2 { done() } else { fill() }
        }
      }
      fill()
    }
  }
  step()
}

func send(_ conn: NWConnection, status: Int, type: String, body: Data) {
  let statusText: String
  switch status {
  case 200: statusText = "OK"
  case 400: statusText = "Bad Request"
  case 404: statusText = "Not Found"
  case 503: statusText = "Service Unavailable"
  default: statusText = "Error"
  }
  let head = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
  var d = Data(head.utf8)
  d.append(body)
  conn.send(content: d, completion: .contentProcessed { _ in conn.cancel() })
}

func sseEvent(_ conn: NWConnection, _ event: String, _ data: Any) {
  let payload = "event: \(event)\ndata: \(String(data: jsonOut(data), encoding: .utf8) ?? "{}")\n\n"
  conn.send(content: Data(payload.utf8), completion: .contentProcessed { _ in })
}

func handleMessages(_ conn: NWConnection, body: Data) async {
  let msgId = "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
  guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
    send(conn, status: 400, type: "application/json", body: apiError(400, "invalid_request_error", "body is not JSON"))
    return
  }
  let streaming = (obj["stream"] as? Bool) ?? false
  do {
    try checkAvailable()
    let req = try parseRequest(obj)
    let maxTokens = try await guardContext(req)
    let allowed = Set(req.tools.compactMap { $0["name"] as? String })

    if !streaming {
      let text = try await generate(req, maxTokens: maxTokens, onDelta: nil)
      var blocks: [[String: Any]] = []
      var stop = "end_turn"
      if let call = parseToolCall(text, allowed: allowed) {
        blocks.append(["type": "tool_use", "id": "tu_\(UUID().uuidString.prefix(8))", "name": call.name, "input": call.input])
        stop = "tool_use"
      } else if !text.isEmpty {
        blocks.append(["type": "text", "text": text])
      }
      let out: [String: Any] = [
        "id": msgId, "type": "message", "role": "assistant", "model": MODEL_ID,
        "content": blocks, "stop_reason": stop, "stop_sequence": NSNull(),
        "usage": ["input_tokens": 0, "output_tokens": max(1, text.count / 4)],
      ]
      send(conn, status: 200, type: "application/json", body: jsonOut(out))
      return
    }

    // streaming SSE (text deltas only; a tool call arrives as its JSON text)
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n"
    conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
    sseEvent(conn, "message_start", ["type": "message_start", "message": ["id": msgId, "type": "message", "role": "assistant", "model": MODEL_ID, "content": [], "stop_reason": NSNull(), "usage": ["input_tokens": 0, "output_tokens": 0]]])
    sseEvent(conn, "content_block_start", ["type": "content_block_start", "index": 0, "content_block": ["type": "text", "text": ""]])
    sseEvent(conn, "ping", ["type": "ping"])
    var text = ""
    do {
      text = try await generate(req, maxTokens: maxTokens) { delta in
        sseEvent(conn, "content_block_delta", ["type": "content_block_delta", "index": 0, "delta": ["type": "text_delta", "text": delta]])
      }
    } catch let e as RequestError {
      sseEvent(conn, "error", ["type": "error", "error": ["type": e.type, "message": e.message]])
      conn.cancel()
      return
    }
    sseEvent(conn, "content_block_stop", ["type": "content_block_stop", "index": 0])
    sseEvent(conn, "message_delta", ["type": "message_delta", "delta": ["stop_reason": "end_turn", "stop_sequence": NSNull()], "usage": ["output_tokens": max(1, text.count / 4)]])
    sseEvent(conn, "message_stop", ["type": "message_stop"])
    conn.cancel()
  } catch let e as RequestError {
    send(conn, status: e.status, type: "application/json", body: apiError(e.status, e.type, e.message))
  } catch let e as LanguageModelError {
    // the model's own context refusal arrives here; speak it as a clean 400
    if case .contextSizeExceeded(let c) = e {
      send(conn, status: 400, type: "application/json", body: apiError(400, "invalid_request_error",
        "request exceeds the apple-fm context limit of \(c.contextSize) tokens (prompt is \(c.tokenCount)): \(c.debugDescription)"))
    } else {
      send(conn, status: 500, type: "application/json", body: apiError(500, "api_error", "apple-fm bridge: \(e)"))
    }
  } catch {
    send(conn, status: 500, type: "application/json", body: apiError(500, "api_error", "apple-fm bridge: \(error)"))
  }
}

func handle(_ conn: NWConnection) {
  readHTTPRequest(conn) { req in
    guard let req else { conn.cancel(); return }
    if req.method == "GET", req.path.hasPrefix("/v1/models") {
      send(conn, status: 200, type: "application/json", body: jsonOut(["data": [["id": MODEL_ID, "type": "model", "display_name": "Apple on-device model (FoundationModels)", "created": "2026-01-01T00:00:00Z"]]]))
      return
    }
    if req.method == "GET", req.path == "/" {
      send(conn, status: 200, type: "application/json", body: jsonOut(["name": "apple-fm-bridge", "model": MODEL_ID, "context": model.contextSize]))
      return
    }
    if req.method == "POST", req.path.hasPrefix("/v1/messages") {
      Task { await handleMessages(conn, body: req.body) }
      return
    }
    send(conn, status: 404, type: "application/json", body: apiError(404, "not_found_error", "no route \(req.method) \(req.path)"))
  }
}

let listener: NWListener
do {
  listener = try NWListener(using: makeParams(), on: NWEndpoint.Port(rawValue: portVal) ?? 8037)
} catch {
  FileHandle.standardError.write(Data("apple-fm-bridge: cannot listen on \(portVal): \(error)\n".utf8))
  exit(1)
}
listener.stateUpdateHandler = { (state: NWListener.State) in
  if case .ready = state { FileHandle.standardError.write(Data("apple-fm-bridge listening on 127.0.0.1:\(portVal) (context \(model.contextSize) tokens)\n".utf8)) }
  if case .failed(let e) = state { FileHandle.standardError.write(Data("apple-fm-bridge failed: \(e)\n".utf8)); exit(1) }
}
listener.newConnectionHandler = { (conn: NWConnection) in
  conn.stateUpdateHandler = { (s: NWConnection.State) in if case .ready = s { handle(conn) } }
  conn.start(queue: .main)
}
listener.start(queue: .main)
dispatchMain()
