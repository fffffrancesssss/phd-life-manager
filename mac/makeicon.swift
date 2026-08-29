// Draws the app icon: the app's own week, on the app's own paper.
//
// Five time blocks scattered across four day-columns at the hours they sit
// at — blocks that share a baseline read as a bar chart, so they deliberately
// do not. Two hour rules run behind them and are drawn again over the top in
// white, so they cut across each block the way the real grid does; that, plus
// a shadow tinted in each block's own colour, is where the depth comes from.
// Fading the blocks themselves was tried and rejected: alpha over paper only
// drains the colour, which reads older rather than newer.
//
// The hues are the app's five section colours raised in chroma and lightness
// — the interface mixes them for text on paper, which is too muted to carry a
// 16px tile.

import Cocoa

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "./AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func color(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
    NSColor(srgbRed: CGFloat(r)/255, green: CGFloat(g)/255, blue: CGFloat(b)/255, alpha: 1)
}
let paper  = color(250, 248, 244)      // --paper
let rule   = color(222, 214, 201)
let indigo = color(91, 124, 245)       // calendar
let amber  = color(245, 173, 58)       // ideas
let teal   = color(45, 200, 150)       // projects
let orange = color(255, 138, 61)       // focus
let violet = color(174, 124, 250)      // journal
let hues = [indigo, amber, teal, orange, violet]

// (day column, top, bottom, hue) as fractions of the tile
let week: [(Int, CGFloat, CGFloat, Int)] = [
    (0, 0.78, 0.44, 0), (1, 0.88, 0.62, 1), (1, 0.54, 0.18, 2),
    (2, 0.70, 0.36, 3), (3, 0.84, 0.28, 4),
]

// Three columns, four blocks, chunkier — the same week with less said.
let weekSmall: [(Int, CGFloat, CGFloat, Int)] = [
    (0, 0.76, 0.40, 0), (1, 0.88, 0.56, 1), (1, 0.48, 0.16, 2), (2, 0.80, 0.34, 4),
]

func hourRules(_ s: CGFloat, _ col: NSColor) {
    col.setStroke()
    let p = NSBezierPath()
    p.lineWidth = max(1, s * 0.014)
    p.lineCapStyle = .round
    for y in [0.66, 0.40] as [CGFloat] {
        p.move(to: NSPoint(x: s * 0.11, y: s * y))
        p.line(to: NSPoint(x: s * 0.89, y: s * y))
    }
    p.stroke()
}

// Detail has to come off as the tile shrinks. The shadow blur that gives the
// blocks depth at 512 turns them to mush at 32, and at 16 there are not
// enough pixels to hold five blocks apart at all — so that size drops to
// three, drawn flat. Apple's own icons change composition this way; what has
// to survive is the impression, not the geometry.
func render(_ px: Int) -> Data {
    let softened = px >= 128        // shadow and the white rules over the top
    let full = px >= 64             // five blocks, or the reduced three
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)

    NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s),
                 xRadius: s * 0.225, yRadius: s * 0.225).setClip()
    paper.setFill()
    NSRect(x: 0, y: 0, width: s, height: s).fill()

    if px >= 32 { hourRules(s, rule) }

    let inset: CGFloat = full ? 0.14 : 0.155, n: CGFloat = full ? 4 : 3
    let span = 1 - inset * 2
    let gap = span * (full ? 0.08 : 0.10)
    let w = (span - gap * (n - 1)) / n
    for b in (full ? week : weekSmall) {
        let x = (inset + CGFloat(b.0) * (w + gap)) * s
        let box = NSRect(x: x, y: b.2 * s, width: w * s, height: (b.1 - b.2) * s)
        let path = NSBezierPath(roundedRect: box, xRadius: w * s * 0.32, yRadius: w * s * 0.32)
        let col = hues[b.3]

        if softened {
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = col.withAlphaComponent(0.42)
            shadow.shadowOffset = NSSize(width: 0, height: -s * 0.018)
            shadow.shadowBlurRadius = s * 0.045
            shadow.set()
            col.setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()
        }
        NSGradient(colors: [col.blended(withFraction: 0.16, of: .white)!, col])!
            .draw(in: path, angle: 90)
    }

    // The same rules again, over the blocks, so they read as cut through.
    // Below 128 they only fog the blocks, so they come off.
    if softened { hourRules(s, NSColor.white.withAlphaComponent(0.30)) }

    NSGraphicsContext.current?.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:]) ?? Data()
}

// Exactly the set iconutil expects — nothing else belongs in an .iconset.
for pt in [16, 32, 128, 256, 512] {
    try? render(pt).write(to: URL(fileURLWithPath: "\(outDir)/icon_\(pt)x\(pt).png"))
    try? render(pt * 2).write(to: URL(fileURLWithPath: "\(outDir)/icon_\(pt)x\(pt)@2x.png"))
}
print("wrote iconset to \(outDir)")
