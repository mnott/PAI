import XCTest
@testable import PAIMenuBarCore

final class SpeakerTests: XCTestCase {
    func testParseDiarization() {
        let t = parseDiarization("Started\n0.318 -- 6.865 speaker_01\n7.0 -- 9.5 speaker_00\nbad line\n")
        XCTAssertEqual(t, [SpeakerTurn(start: 0.318, end: 6.865, speaker: 1), SpeakerTurn(start: 7, end: 9.5, speaker: 0)])
    }

    func testParseSegments() {
        let j = #"{"segments":[{"start":0,"end":2.5,"text":" Hi there "},{"start":2.5,"end":3,"text":" "}]}"#
        XCTAssertEqual(parseSegments(Data(j.utf8)), [TextSegment(start: 0, end: 2.5, text: "Hi there")])
        XCTAssertEqual(parseSegments(Data("x".utf8)), [])
    }

    func testLabelMergeAndNumbering() {
        let turns = [SpeakerTurn(start: 0, end: 4, speaker: 7), SpeakerTurn(start: 4, end: 8, speaker: 2)]
        let segs = [TextSegment(start: 0, end: 2, text: "Hello."), TextSegment(start: 2, end: 3.9, text: "How are you?"),
                    TextSegment(start: 3.5, end: 7, text: "Fine."), TextSegment(start: 7, end: 8, text: "Thanks.")]
        XCTAssertEqual(labelSpeakers(segments: segs, turns: turns),
                       "Speaker 1: Hello. How are you?\nSpeaker 2: Fine. Thanks.")
    }

    func testFallbackPlain() {
        let segs = [TextSegment(start: 0, end: 1, text: "A"), TextSegment(start: 1, end: 2, text: "B")]
        XCTAssertEqual(labelSpeakers(segments: segs, turns: []), "A B")
    }
}
