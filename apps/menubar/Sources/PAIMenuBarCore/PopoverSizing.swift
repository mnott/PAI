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
