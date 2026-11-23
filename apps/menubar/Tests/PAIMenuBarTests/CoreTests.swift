import XCTest
@testable import PAIMenuBarCore

func fixture(_ name: String) -> Data {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/\(name).json")
    return try! Data(contentsOf: url)
}

final class CoreTests: XCTestCase {
    func testDecodeAllFixtures() throws {
        let limits = try JSONDecoder().decode(LimitsResponse.self, from: fixture("limits"))
        XCTAssertNotNil(limits.limits)
        let system = try JSONDecoder().decode(SystemResponse.self, from: fixture("system"))
        XCTAssertNotNil(system.current?.memTotal)
        let queue = try JSONDecoder().decode(QueueResponse.self, from: fixture("queue"))
        XCTAssertFalse(queue.table!.isEmpty)
        let data = try JSONDecoder().decode(DataResponse.self, from: fixture("data"))
        XCTAssertFalse(data.speed!.isEmpty)
    }

    func testCloudLimitFiltering() throws {
        let limits = try JSONDecoder().decode(LimitsResponse.self, from: fixture("limits"))
        let active = limits.activeCloud()
        // Only providers with kind != local, no error, non-empty windows.
        XCTAssertFalse(active.contains(where: { $0.kind == "local" }))
        for l in active {
            XCTAssertNil(l.error)
            XCTAssertFalse((l.windows ?? []).isEmpty)
        }
        XCTAssertEqual(active.count, 1) // only anthropic has windows in the fixture
        XCTAssertEqual(active.first?.provider, "anthropic")
    }

    func testResetFormatting() {
        let now: Double = 1_000_000_000_000
        XCTAssertEqual(formatReset(now: now, resetAt: now + 2 * 86400_000 + 3 * 3600_000), "resets in 2d 3h")
        XCTAssertEqual(formatReset(now: now, resetAt: now - 1000), "resets in 0d 0h")
    }

    func testElapsedFormatting() {
        XCTAssertEqual(formatElapsed(seconds: 59), "59s")
        XCTAssertEqual(formatElapsed(seconds: 720), "12m")
        XCTAssertEqual(formatElapsed(seconds: 3900), "1h05")
    }

    func testTTFTJoinForLocalModels() throws {
        let data = try JSONDecoder().decode(DataResponse.self, from: fixture("data"))
        // h1 present -> use h1; h1 null -> fall back to h24.
        let withH1 = data.speed!.first(where: { $0.h1?.ttftP50 != nil })!
        let (p50, _) = data.ttft(provider: withH1.provider!)
        XCTAssertEqual(p50, withH1.h1?.ttftP50)

        let nullH1 = data.speed!.first(where: { $0.h1?.ttftP50 == nil && $0.h24?.ttftP50 != nil })!
        let (p50b, p90b) = data.ttft(provider: nullH1.provider!)
        XCTAssertEqual(p50b, nullH1.h24?.ttftP50)
        XCTAssertEqual(p90b, nullH1.h24?.ttftP90)

        let (none, _) = data.ttft(provider: "nonexistent-provider")
        XCTAssertNil(none)
    }

    func testJobGroupingBySession() throws {
        let queue = try JSONDecoder().decode(QueueResponse.self, from: fixture("queue"))
        let groups = queue.groupedBySession()
        let sessions = groups.map(\.session)
        XCTAssertEqual(sessions, sessions.sorted())
        let total = groups.reduce(0) { $0 + $1.rows.count }
        XCTAssertEqual(total, queue.jobs().count)
        XCTAssertFalse(queue.jobs().contains(where: { $0.kind != "job" }))
    }

    func testActionRequestBuilder() throws {
        let base = URL(string: "http://127.0.0.1:8790")!
        let req = actionRequest(baseURL: base, id: "abc-123", action: "stop")
        XCTAssertEqual(req.url?.absoluteString, "http://127.0.0.1:8790/cockpit/queue/act")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
        XCTAssertEqual(body["action"], "stop")
        XCTAssertEqual(body["id"], "abc-123")
    }

    func testMenuTitle() {
        XCTAssertEqual(menuTitle(running: 3, gpu: 99.6), "3▸ GPU 100%")
        XCTAssertEqual(menuTitle(running: 0, gpu: nil), "0▸")
    }
}
