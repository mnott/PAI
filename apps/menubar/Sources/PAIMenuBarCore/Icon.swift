import AppKit

/// Cockpit favicon, drawn monochrome as a template image for the menu bar:
/// four fan-out lines and three dots (no rounded square background).
public func makeMenuBarIcon() -> NSImage {
    let size = NSSize(width: 18, height: 14)
    let img = NSImage(size: size)
    img.lockFocus()
    let scale = size.width / 64.0
    func pt(_ x: Double, _ y: Double) -> NSPoint { NSPoint(x: x * scale, y: (64 - y) * scale) }

    NSColor.black.set()
    let lines = NSBezierPath()
    lines.lineWidth = 5 * scale
    lines.lineCapStyle = .round
    lines.move(to: pt(8, 32)); lines.line(to: pt(24, 32))
    lines.move(to: pt(24, 32)); lines.line(to: pt(46, 14))
    lines.move(to: pt(24, 32)); lines.line(to: pt(46, 32))
    lines.move(to: pt(24, 32)); lines.line(to: pt(46, 50))
    lines.stroke()

    for (x, y) in [(50.0, 14.0), (50.0, 32.0), (50.0, 50.0)] {
        let r = 4 * scale
        NSBezierPath(ovalIn: NSRect(x: pt(x, y).x - r, y: pt(x, y).y - r, width: r * 2, height: r * 2)).fill()
    }
    img.unlockFocus()
    img.isTemplate = true
    return img
}
