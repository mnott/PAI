// pai-sensors — one-shot SoC temperature reader, no sudo, no resident process.
//
// Reads the Apple Silicon PMU temperature services through IOKit's private
// IOHIDEventSystemClient: setMatching({PrimaryUsagePage 0xff00, PrimaryUsage 5})
// then CopyServices; per service CopyEvent(type 15 = temperature) and
// EventGetFloatValue(event, 15 << 16). SoC die sensors are named "PMU tdie*" /
// "PMU tdev*"; unset slots read a large negative sentinel. This is the same
// path mactop uses; the approach follows upstream Strata PR #5793
// (serve/telemetry.py, MIT) and exelban/stats — re-implemented here, no code
// copied. One run reads every temperature service once and prints one JSON
// line:  {"socTempC": <max of die sensors>, "socTempAvgC": <avg>, "sensors": n}
// Exits in well under 100 ms; failures print one JSON line with "error".
// MIT licensed; Foundation + IOKit only.

import Foundation
import IOKit

typealias ClientPtr = UnsafeMutableRawPointer
typealias ServicePtr = UnsafeMutableRawPointer

@_silgen_name("IOHIDEventSystemClientCreate") func IOHIDESC(_ cf: CFAllocator!) -> ClientPtr?
@_silgen_name("IOHIDEventSystemClientSetMatching") func IOHESCSM(_ c: ClientPtr, _ m: CFDictionary!) -> Int32
@_silgen_name("IOHIDEventSystemClientCopyServices") func IOHESCCS(_ c: ClientPtr) -> Unmanaged<CFArray>?
@_silgen_name("IOHIDServiceClientCopyProperty") func HSCP(_ s: ServicePtr, _ k: CFString!) -> Unmanaged<CFTypeRef>?
@_silgen_name("IOHIDServiceClientCopyEvent") func HSCE(_ s: ServicePtr, _ t: Int32, _ o: Int32, _ x: CFDictionary?) -> Unmanaged<CFTypeRef>?
@_silgen_name("IOHIDEventGetFloatValue") func HEGFV(_ e: CFTypeRef!, _ f: Int32) -> Double

let kTemperature: Int32 = 15                 // kIOHIDEventTypeTemperature
let kTempField: Int32 = kTemperature << 16   // the event's value field is type << 16

func prop(_ s: ServicePtr, _ k: String) -> AnyObject? { HSCP(s, k as CFString)?.takeRetainedValue() }

func fail(_ why: String) -> Never {
  print("{\"socTempC\":null,\"socTempAvgC\":null,\"sensors\":0,\"error\":\"\(why)\"}")
  exit(1)
}

guard let client = IOHIDESC(nil) else { fail("client") }
// without the matching filter CopyServices returns no temperature services
_ = IOHESCSM(client, ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 5] as CFDictionary)
guard let raw = IOHESCCS(client)?.takeRetainedValue() else { fail("services") }
var die: [Double] = [], all: [Double] = []
for case let sObj in raw as [AnyObject] {
  let s = unsafeBitCast(sObj, to: ServicePtr.self)
  guard let ev = HSCE(s, kTemperature, 0, nil)?.takeRetainedValue() else { continue }
  let c = HEGFV(ev, kTempField)
  guard c > 0 && c < 200 else { continue } // plausible °C; unset slots read a negative sentinel
  all.append(c)
  if let name = prop(s, "Product") as? String, name.contains("tdie") || name.contains("tdev") { die.append(c) }
}
let pool = die.isEmpty ? all : die
guard !pool.isEmpty else { fail("no temperature sensors") }
let mx = pool.max()!, avg = pool.reduce(0, +) / Double(pool.count)
print(String(format: "{\"socTempC\":%.1f,\"socTempAvgC\":%.1f,\"sensors\":%d}", mx, avg, pool.count))
