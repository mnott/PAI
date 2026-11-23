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

    func queue() throws -> QueueResponse { try JSONDecoder().decode(QueueResponse.self, from: fixture("queue")) }

    func testModelChipsPerWhereItRuns() throws {
        let jobs = try queue().jobs()
        let texts = jobs.map(modelChipText)
        XCTAssertTrue(texts.contains("↑ cloud: sonnet"))
        XCTAssertTrue(texts.contains("signal-2 #1"))
        XCTAssertTrue(texts.contains("signal-2 #2"))
        let cloud = jobs.first { $0.local == false }!
        XCTAssertEqual(modelHue(model: cloud.model!, local: false), 270)
        XCTAssertEqual(modelHue(model: "signal-2", local: true), localHue)
    }

    func testSectionsIncludePausedAndWaiting() throws {
        let secs = try queue().sections()
        XCTAssertEqual(secs.map(\.name), ["Running", "Waiting", "Paused"])
        XCTAssertEqual(secs.map(\.rows.count), [6, 1, 1])
        XCTAssertEqual(secs[2].rows.first?.task, "paused fixture job")
        XCTAssertEqual(secs[2].rows.first?.topic, "snapshot")
        // empty sections stay present for a stable layout
        XCTAssertEqual(try queue().sections(rows: []).map(\.rows.count), [0, 0, 0])
    }

    func testInstanceSummaryAndIdle() throws {
        let q = try queue()
        XCTAssertEqual(q.instanceSummary(provider: "signal-2"), "#1 1/2 · #2 2/2")
        XCTAssertEqual(q.busyTotal(provider: "signal-2"), 3)
        XCTAssertEqual(q.instanceStats(provider: "apple-fm"), [.init(label: "#1", busy: 0, cap: 1)])
        let limits = try JSONDecoder().decode(LimitsResponse.self, from: fixture("limits"))
        let l = limits.localUp().first!
        XCTAssertFalse(localIdle(limit: l, busy: q.busyTotal(provider: "signal-2")))
        XCTAssertTrue(localIdle(limit: l, busy: 0))
    }

    func testPaceDecoded() throws {
        let limits = try JSONDecoder().decode(LimitsResponse.self, from: fixture("limits"))
        XCTAssertEqual(limits.activeCloud().first?.windows?.first?.pace, 62.5)
    }

    func testSessionHuesStableAndDistinct() throws {
        XCTAssertEqual(nameHash("alpha"), nameHash("alpha"))
        let hues = try queue().sessionHues()
        XCTAssertEqual(Set(hues.values).count, hues.count)
        XCTAssertEqual(hues["alpha"], assignHues(["alpha"])["alpha"].map { _ in hues["alpha"]! })
        XCTAssertTrue(sessionHuePalette.contains(hue(for: "anything")))
    }

    func testStateColoursAndChipDarkLight() {
        XCTAssertEqual(Palette.state("running"), Palette.ok)
        XCTAssertEqual(Palette.state("waiting"), Palette.warn)
        XCTAssertEqual(Palette.state("paused"), Palette.dim)
        XCTAssertNotEqual(Palette.ok.light, Palette.ok.dark)
        let l = chipColors(hue: 270, dark: false), d = chipColors(hue: 270, dark: true)
        XCTAssertLessThan(l.text.l, d.text.l) // lighter text on the dark menu bar
        XCTAssertEqual(chipColors(hue: 10, dark: false, topic: true).fill.a, 0)
        let c = rgb(HSLA(0, 100, 50))
        XCTAssertEqual(c.r, 1, accuracy: 0.01); XCTAssertEqual(c.g, 0, accuracy: 0.01)
    }

    func testFilterJobs() throws {
        let rows = try queue().jobs()
        XCTAssertEqual(filterJobs(rows, query: "").count, rows.count)
        XCTAssertEqual(filterJobs(rows, query: "PAUSED fixture").count, 1)
        XCTAssertEqual(filterJobs(rows, query: "cloud: sonnet").count, 1)
    }

    func testMachineBadgeAndRequest() throws {
        XCTAssertEqual(machineBadge(nil), "normal")
        let tz = TimeZone(identifier: "UTC")!
        let m = QueueResponse.Machine(state: "frozen", since: 1_700_000_000_000, until: nil)
        XCTAssertEqual(machineBadge(m, timeZone: tz), "frozen since 22:13")
        XCTAssertEqual(machineBadge(.init(state: "deep-frozen", since: nil, until: nil)), "deep-frozen")
        let req = machineActionRequest(baseURL: URL(string: "http://127.0.0.1:8790")!, action: "freeze", forMs: 900_000)
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["action"] as? String, "freeze")
        XCTAssertEqual(body["all"] as? Bool, true)
        XCTAssertEqual(body["forMs"] as? Double, 900_000)
    }

    func testEndpointCandidatesAndPick() async throws {
        let tail = parseTailnetHost(json: Data(#"{"Self":{"DNSName":"box.example.ts.net."}}"#.utf8))
        XCTAssertEqual(tail, "box.example.ts.net")
        let c = buildCandidates(tailnetHost: tail, extras: ["other.lan", "127.0.0.1:8790", "http://x:9000/"])
        XCTAssertEqual(c.map(\.url.absoluteString),
                       ["http://127.0.0.1:8790", "http://box.example.ts.net:8790", "http://other.lan:8790", "http://x:9000"])
        XCTAssertEqual(c.first?.label, "local")
        // first answering wins, in order; none -> nil
        let second = await pickEndpoint(c) { $0.host == "box.example.ts.net" || $0.host == "x" }
        XCTAssertEqual(second?.label, "tailnet")
        let none = await pickEndpoint(c) { _ in false }
        XCTAssertNil(none)
        XCTAssertNil(normalizeHost("  "))
    }

    func testTailSeriesKeepsLastSixMinutes() {
        let s = (0..<20).map { SystemResponse.Sample(t: Double($0) * 60_000, cpu: 1) }
        XCTAssertEqual(tailSeries(s).count, 7)
    }

    // The popover window must follow the content's ideal height (sections
    // appear/disappear: queue rows, battery chart on battery only), capped at
    // the screen's visible height with scrolling beyond it.
    func testPopoverHeightFollowsContent() {
        // few jobs, no battery: short content; many jobs: taller content
        XCTAssertEqual(popoverHeight(ideal: 300, visibleHeight: 900), 300)
        XCTAssertEqual(popoverHeight(ideal: 640, visibleHeight: 900), 640)
        // battery chart appears on battery only: content grows, window follows
        XCTAssertLessThan(popoverHeight(ideal: 300, visibleHeight: 900), popoverHeight(ideal: 380, visibleHeight: 900))
        // taller than the screen: capped, and the content scrolls
        XCTAssertEqual(popoverHeight(ideal: 1200, visibleHeight: 900), 900)
        XCTAssertTrue(popoverNeedsScroll(ideal: 1200, visibleHeight: 900))
        XCTAssertFalse(popoverNeedsScroll(ideal: 640, visibleHeight: 900))
        // never below the floor
        XCTAssertEqual(popoverHeight(ideal: 40, visibleHeight: 900), 120)
    }
}

@MainActor
final class StoreHistoryTests: XCTestCase {
    func sys(now: Double, cpu: Double, buckets: [Double] = []) -> SystemResponse {
        SystemResponse(now: now,
                       current: .init(cpu: cpu, gpu: cpu / 2, socTemp: 60, systemW: 30, memTotal: 100, memUsed: 50),
                       series: .init(series: buckets.map { .init(t: $0, cpu: 10) }))
    }

    func testSuccessiveSamplesGrowChartSeries() {
        let store = Store()
        store.ingest(system: sys(now: 1_000_000, cpu: 10, buckets: [400_000, 700_000]))
        let first = tailSeries(store.history)
        XCTAssertEqual(store.history.count, 3) // 2 seed buckets + 1 live
        store.ingest(system: sys(now: 1_002_500, cpu: 20, buckets: [400_000, 700_000]))
        let second = tailSeries(store.history)
        XCTAssertEqual(store.history.count, 4)
        XCTAssertEqual(second.count, first.count + 1)
        XCTAssertEqual(second.compactMap(\.cpu).last, 20)
        XCTAssertEqual(store.history.last?.memPct, 50)
    }

    func testHistoryCapped() {
        let store = Store()
        for i in 0..<(Store.historyCap + 50) { store.ingest(system: sys(now: 1_000_000 + Double(i) * 1000, cpu: 1)) }
        XCTAssertEqual(store.history.count, Store.historyCap)
    }
}

@MainActor
final class StoreLiveTests: XCTestCase {
    func testSeedDroppedOnceLiveSamplesExist() {
        let store = Store()
        for i in 0..<Store.liveMin {
            store.ingest(system: SystemResponse(now: 1_000_000 + Double(i) * 2500,
                current: .init(cpu: Double(i * 7 % 13)), series: .init(series: [.init(t: 1, cpu: 1), .init(t: 2, cpu: 1)])))
        }
        XCTAssertEqual(store.history.count, Store.liveMin)
        XCTAssertGreaterThan(Set(store.history.compactMap(\.cpu)).count, 2)
    }

    func testLastSpeedSurvivesZeroReading() throws {
        let store = Store()
        let live = try JSONDecoder().decode(LimitsResponse.self, from: fixture("limits"))
        store.ingest(limits: live)
        XCTAssertEqual(store.lastSpeed["signal-2"]?.decodeTps, 40.2)
        var zero = live
        for i in zero.limits!.indices where zero.limits![i].provider == "signal-2" { zero.limits![i].speed = .init(prefillTps: 0, decodeTps: nil) }
        store.ingest(limits: zero)
        XCTAssertEqual(store.lastSpeed["signal-2"]?.decodeTps, 40.2)
        XCTAssertEqual(speedText("decode", live: nil, last: 40.2), "decode 40 t/s")
        XCTAssertEqual(speedText("decode", live: nil, last: nil), "decode —")
    }
}

final class PowerTests: XCTestCase {
    let custom = """
    Battery Power:
     lowpowermode         1
     powermode            0
    AC Power:
     lowpowermode         0
     powermode            2
    """

    func testPowerModePerSource() {
        XCTAssertEqual(parsePowerMode(pmsetCustom: custom, onBattery: true), .low)
        XCTAssertEqual(parsePowerMode(pmsetCustom: custom, onBattery: false), .high)
        XCTAssertEqual(parsePowerMode(pmsetCustom: "AC Power:\n powermode 0\n", onBattery: false), .auto)
    }

    func testBatteryParse() {
        let ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; AC attached; not charging present: true\n"
        XCTAssertEqual(parseBattery(pmsetBatt: ac)?.state, "ac")
        let dis = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t55%; discharging; 3:20 remaining present: true\n"
        let b = parseBattery(pmsetBatt: dis)!
        XCTAssertEqual(b.percent, 55); XCTAssertEqual(b.state, "discharging")
        XCTAssertEqual(b.macRemainingMin, 200); XCTAssertTrue(b.onBattery)
        XCTAssertNil(parseBattery(pmsetBatt: "Now drawing from 'AC Power'\n"))
        let chg = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t55%; charging; 1:10 remaining present: true\n"
        XCTAssertEqual(parseBattery(pmsetBatt: chg)?.state, "charging")
    }

    func testRuntimeAtCurrentUsage() {
        let info = BatteryInfo(percent: 55, state: "discharging", macRemainingMin: 200, onBattery: true)
        XCTAssertEqual(runtimeText(info: info, remainingWh: 78.5, watts: 35), "2h 15m at 35 W")
        XCTAssertEqual(runtimeText(info: info, remainingWh: nil, watts: 35), "3h 20m (macOS estimate)")
        var ac = info; ac.state = "charging"
        XCTAssertNil(runtimeText(info: ac, remainingWh: 78, watts: 35))
        XCTAssertEqual(parseRemainingWh(ioreg: "\"Voltage\" = 12000\n\"AppleRawCurrentCapacity\" = 6000\n"), 72)
        let s = [SystemResponse.Sample(t: 0, systemW: 100), .init(t: 100_000, systemW: 30), .init(t: 150_000, systemW: 40)]
        XCTAssertEqual(smoothedWatts(s), 35) // last 90 s only
    }

    func testSudoersAndCommands() {
        XCTAssertEqual(sudoersText(user: "someone"), """
        someone ALL=(root) NOPASSWD: /usr/bin/pmset -a powermode 0
        someone ALL=(root) NOPASSWD: /usr/bin/pmset -a powermode 1
        someone ALL=(root) NOPASSWD: /usr/bin/pmset -a powermode 2

        """)
        XCTAssertEqual(powerModeCommand(.high), ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-a", "powermode", "2"])
        XCTAssertEqual(powerModeAdminShell(.low), "/usr/bin/pmset -a powermode 1")
        let script = sudoersInstallScript(user: "someone")
        XCTAssertTrue(script.contains("visudo -cf"))
        XCTAssertTrue(script.contains("chmod 0440"))
        XCTAssertTrue(script.contains("root:wheel"))
        XCTAssertTrue(script.contains(sudoersPath))
        XCTAssertEqual(sudoersRemoveScript, "/bin/rm -f /etc/sudoers.d/pai-powermode")
    }
}

final class CountingProtocol: URLProtocol {
    nonisolated(unsafe) static var hits = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        CountingProtocol.hits += 1
        let r = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class StoreOpenRefreshTests: XCTestCase {
    func testOpenRefreshPollsAndDebounces() async {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [CountingProtocol.self]
        let store = Store(session: URLSession(configuration: cfg))
        let base = URL(string: "http://localhost:1")!
        CountingProtocol.hits = 0
        let first = await store.refreshOnOpen(baseURL: base)
        XCTAssertTrue(first)
        XCTAssertGreaterThanOrEqual(CountingProtocol.hits, 3) // limits, system, queue
        let after = CountingProtocol.hits
        let second = await store.refreshOnOpen(baseURL: base, now: store.lastPoll.addingTimeInterval(0.5))
        XCTAssertFalse(second)
        XCTAssertEqual(CountingProtocol.hits, after)
        let later = await store.refreshOnOpen(baseURL: base, now: store.lastPoll.addingTimeInterval(1.5))
        XCTAssertTrue(later)
        XCTAssertGreaterThan(CountingProtocol.hits, after)
    }

    func testStaleLineOnlyAfterFailure() async {
        let store = Store()
        XCTAssertNil(store.staleLine())
        await store.refresh(baseURL: URL(string: "http://127.0.0.1:1")!)
        XCTAssertNil(store.staleLine()) // never succeeded: nothing to age
    }
}

final class ANEAndModeTests: XCTestCase {
    func testEnergyDeltaToWatts() {
        XCTAssertEqual(energyToWatts(delta: 1500, unit: "mJ", seconds: 1.0)!, 1.5, accuracy: 1e-9)
        XCTAssertEqual(energyToWatts(delta: 3_000_000, unit: "uJ", seconds: 2.0)!, 1.5, accuracy: 1e-9)
        XCTAssertEqual(energyToWatts(delta: 2_000_000_000, unit: "nJ", seconds: 4.0)!, 0.5, accuracy: 1e-9)
        XCTAssertEqual(energyToWatts(delta: 6, unit: "J", seconds: 3)!, 2, accuracy: 1e-9)
        XCTAssertNil(energyToWatts(delta: 1, unit: "mJ", seconds: 0))
        XCTAssertNil(energyToWatts(delta: 1, unit: "furlong", seconds: 1))
        XCTAssertNil(energyToWatts(delta: -5, unit: "mJ", seconds: 1))
    }

    func testWorkModeRuleAndParse() {
        XCTAssertEqual(workModeRule(.balanced, used: 21, pace: 34), "cloud first: 21% < 80% of pace 34%")
        XCTAssertEqual(workModeRule(.balanced, used: 40, pace: 34), "local first: 40% >= 80% of pace 34%")
        XCTAssertEqual(parseWorkMode("mode: budget \u{2014} t2 = local only"), .budget)
        XCTAssertNil(parseWorkMode("garbage"))
    }

    func testBatteryCaption() {
        let chg = BatteryInfo(percent: 50, state: "charging", macRemainingMin: 40, onBattery: false)
        XCTAssertEqual(batteryCaption(info: chg, remainingWh: nil, watts: nil), "charging, full in 40m")
        let ac = BatteryInfo(percent: 100, state: "charged", macRemainingMin: nil, onBattery: false)
        XCTAssertEqual(batteryCaption(info: ac, remainingWh: nil, watts: nil), "on AC")
    }
}
