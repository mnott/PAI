import Foundation

/// The popover window used to be pinned to a fixed height, so when sections
/// appeared or disappeared (battery chart, queue rows) the window kept its old
/// size and left an empty band above or below the content. The window now
/// follows the content's ideal height; these are the pure rules that make that
/// safe, so they are unit-testable without AppKit.

/// The content's ideal height, clamped to what fits on screen.
public func popoverHeight(ideal: Double, visibleHeight: Double, floor: Double = 120) -> Double {
    max(floor, Swift.min(ideal, visibleHeight))
}

/// True when the content is taller than the screen and must scroll.
public func popoverNeedsScroll(ideal: Double, visibleHeight: Double) -> Bool {
    ideal > visibleHeight
}

/// The height the window gets for measured content. A fresh popover measures 0
/// before its first layout; feeding that back would collapse the window and the
/// content could never re-measure, so it is treated as "not measured yet" — the
/// window stays at whatever AppKit gave it (content-sized) until a real height
/// arrives. Any positive measurement replaces the size, so rows appearing or
/// disappearing resize the panel immediately.
public func popoverWindowSize(measured: Double, visibleHeight: Double, floor: Double = 120) -> Double? {
    measured <= 0 ? nil : popoverHeight(ideal: measured, visibleHeight: visibleHeight, floor: floor)
}

/// The window's top edge after a resize. AppKit grows a window from its origin
/// (bottom), so without this the panel drifts down and leaves a gap under the
/// menu bar; anchoring the top keeps it hanging directly below the status item.
public func anchoredTop(_ frame: CGRect, newHeight: Double) -> Double {
    frame.maxY
}

/// The window rect for a given height with the top edge held fixed.
public func resizedFrame(_ frame: CGRect, height: Double) -> CGRect {
    let h = Swift.min(height, Double(frame.maxY))
    return CGRect(x: frame.minX, y: frame.maxY - h, width: frame.width, height: h)
}

/// True when the window rect already matches the target (no resize needed).
public func frameMatches(_ frame: CGRect, size: CGSize) -> Bool {
    frame.width == size.width && frame.height == size.height
}
