// Rebuild the checked-in app icon on macOS: swift scripts/build-icon.swift
import AppKit
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: size, height: size).fill()
// Apple's macOS icon grid: an 824pt tile inset 100pt, so macOS doesn't place the icon on its own gray tile.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
// The app's own grays: sidebar #2d2d2d at the top fading to the window background #181818.
func gray(_ hex: CGFloat) -> NSColor { NSColor(srgbRed: hex / 255, green: hex / 255, blue: hex / 255, alpha: 1) }
NSGradient(starting: gray(0x2d), ending: gray(0x18))!.draw(in: shape, angle: -90)
// A faint edge keeps the tile visible on dark Docks and wallpapers.
let edge = NSBezierPath(roundedRect: tile.insetBy(dx: 2, dy: 2), xRadius: 183, yRadius: 183)
edge.lineWidth = 4
gray(0x42).withAlphaComponent(0.8).setStroke()
edge.stroke()
let font = NSFont(name: "Georgia-BoldItalic", size: 560) ?? NSFont(name: "Times-BoldItalic", size: 560)!
let text = "w" as NSString
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
let bounds = text.size(withAttributes: attrs)
text.draw(at: NSPoint(x: (1024 - bounds.width) / 2 - 8, y: (1024 - bounds.height) / 2 + 75), withAttributes: attrs)
NSGraphicsContext.restoreGraphicsState()
let data = bitmap.representation(using: .png, properties: [:])!
try FileManager.default.createDirectory(atPath: "app/ui/assets", withIntermediateDirectories: true)
try data.write(to: URL(fileURLWithPath: "app/ui/assets/icon.png"))
print("Built app/ui/assets/icon.png")
