// A picture of the whole window without the screen: the panels drawn offscreen over the traced frame. For tests and
// screenshots (`app.shot`); it works while the display sleeps, which a screen capture does not.
import AppKit

enum WindowShot {
    /// Composes the window's content over `frame` (a snapshot of the 3D view) and writes a PNG. Returns its size in pixels.
    static func compose(view: RenderNSView, frame: String, to path: String) -> (width: Int, height: Int) {
        guard let window = view.window, let content = window.contentView else { return (0, 0) }
        let bounds = content.bounds
        let scale = window.backingScaleFactor
        let (w, h) = (Int(bounds.width * scale), Int(bounds.height * scale))
        // The panels alone: the Metal view hidden, so what is under them stays clear.
        view.isHidden = true
        let ui = content.bitmapImageRepForCachingDisplay(in: bounds)
        if let ui { content.cacheDisplay(in: bounds, to: ui) }
        view.isHidden = false
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return (0, 0) }
        out.size = bounds.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        NSColor.black.setFill()
        bounds.fill()
        if let image = NSImage(contentsOfFile: frame) {
            image.draw(in: view.convert(view.bounds, to: nil))
        }
        ui?.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        try? out.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        try? FileManager.default.removeItem(atPath: frame)
        return (w, h)
    }
}
