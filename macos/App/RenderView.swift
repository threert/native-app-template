// The 3D view: a CAMetalLayer the renderer (core/) draws into from its own thread, and the pointer and keys it reads.
// Everything the scene and the renderer report comes back through `rt_poll`, polled on the main run loop.
import AppKit
import QuartzCore
import SwiftUI

final class RenderNSView: NSView {
    let metal = CAMetalLayer()
    private(set) var handle: OpaquePointer?
    /// Called on the main thread with every batch of messages from the core (core/src/lib.rs lists them).
    var onPosts: (([[String: Any]]) -> Void)?
    private var timer: Timer?
    private var tracking: NSTrackingArea?
    private var lastSize = CGSize.zero
    /// The bundle to start with, once the view has a size.
    private var bundle: String?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer = metal
        metal.isOpaque = true
        metal.backgroundColor = NSColor.black.cgColor
        metal.framebufferOnly = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The most pixels the view is traced at: a Retina window's 5 million would halve the frame rate for sharpness the
    /// path tracer's own resolve does not have. The layer is scaled up to the view.
    static var maxPixels: CGFloat = 1_900_000
    private var scale: CGFloat {
        let backing = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        let points = max(bounds.width * bounds.height, 1)
        return min(backing, (RenderNSView.maxPixels / points).squareRoot())
    }
    private var pixels: (UInt32, UInt32) {
        (UInt32(max(1, (bounds.width * scale).rounded())), UInt32(max(1, (bounds.height * scale).rounded())))
    }

    /// Starts the renderer on `bundle` (now, or as soon as the view is laid out).
    func start(bundle: String) {
        self.bundle = bundle
        guard handle == nil, bounds.width > 8, bounds.height > 8 else { return }
        metal.contentsScale = scale
        let (w, h) = pixels
        lastSize = bounds.size
        handle = rt_create(Unmanaged.passUnretained(metal).toOpaque(), w, h, Float(scale), bundle, Paths.scene, Paths.presets)
        if timer == nil {
            let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.poll() }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    /// Ends the renderer (its thread is joined).
    func stop() {
        poll()
        if let handle { rt_destroy(handle) }
        handle = nil
    }

    private func poll() {
        guard let handle, let text = rt_poll(handle) else { return }
        defer { rt_free(text) }
        guard let data = String(cString: text).data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        onPosts?(list)
    }

    override func layout() {
        super.layout()
        if handle == nil { if let bundle { start(bundle: bundle) }; return }
        guard bounds.size != lastSize, bounds.width > 8, bounds.height > 8 else { return }
        lastSize = bounds.size
        metal.contentsScale = scale
        let (w, h) = pixels
        rt_resize(handle, w, h, Float(scale))
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        lastSize = .zero
        needsLayout = true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    // ----- input: the scene reads it as `f.input` (pointer: "free") -----

    private func point(_ event: NSEvent) {
        guard let handle else { return }
        let p = convert(event.locationInWindow, from: nil)
        rt_pointer(handle, Float(p.x / max(bounds.width, 1)), Float(p.y / max(bounds.height, 1)))
    }
    override func mouseMoved(with event: NSEvent) { point(event) }
    override func mouseDragged(with event: NSEvent) { point(event) }
    override func rightMouseDragged(with event: NSEvent) { point(event) }
    override func otherMouseDragged(with event: NSEvent) { point(event) }
    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); point(event); rt_button(handle, 0, true) }
    override func mouseUp(with event: NSEvent) { point(event); rt_button(handle, 0, false) }
    override func rightMouseDown(with event: NSEvent) { point(event); rt_button(handle, 2, true) }
    override func rightMouseUp(with event: NSEvent) { point(event); rt_button(handle, 2, false) }
    override func otherMouseDown(with event: NSEvent) { point(event); rt_button(handle, 1, true) }
    override func otherMouseUp(with event: NSEvent) { point(event); rt_button(handle, 1, false) }
    override func scrollWheel(with event: NSEvent) {
        // A wheel's line is a notch; a trackpad's points are a fortieth of one.
        let dy = event.hasPreciseScrollingDeltas ? Float(event.scrollingDeltaY) / 40 : Float(event.scrollingDeltaY)
        if dy != 0 { rt_wheel(handle, dy) }
    }
    override func magnify(with event: NSEvent) { rt_wheel(handle, Float(event.magnification) * 6) }

    private static let named: [UInt16: String] = [
        49: "Space", 53: "Escape", 36: "Enter", 48: "Tab", 51: "Backspace", 123: "Left", 124: "Right", 125: "Down", 126: "Up",
        56: "Shift", 60: "Shift", 59: "Ctrl", 62: "Ctrl", 58: "Alt", 61: "Alt", 55: "Meta", 54: "Meta",
    ]
    private func key(_ event: NSEvent, down: Bool) {
        var name = RenderNSView.named[event.keyCode]
        if name == nil, let c = event.charactersIgnoringModifiers?.uppercased(), c.count == 1, let ch = c.unicodeScalars.first,
           (ch.value >= 65 && ch.value <= 90) || (ch.value >= 48 && ch.value <= 57) { name = c }
        guard let name else { return }
        key(name, down: down)
    }
    /// Keys the scene holds down: released together when the view loses the keyboard (a held W would stay down).
    private var held: Set<String> = []
    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) { super.keyDown(with: event); return }
        if !event.isARepeat { key(event, down: true) }
    }
    override func keyUp(with event: NSEvent) { key(event, down: false) }
    /// Shift, Ctrl, Alt and Cmd come as a change of the modifier flags, not as keyDown / keyUp.
    override func flagsChanged(with event: NSEvent) {
        let flag: NSEvent.ModifierFlags
        switch event.keyCode {
        case 56, 60: flag = .shift
        case 59, 62: flag = .control
        case 58, 61: flag = .option
        case 55, 54: flag = .command
        default: super.flagsChanged(with: event); return
        }
        key(event, down: event.modifierFlags.contains(flag))
    }
    private func releaseKeys() { for name in held { key(name, down: false) } }
    override func resignFirstResponder() -> Bool {
        releaseKeys()
        return super.resignFirstResponder()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Another app or window takes the keyboard: its key-ups never reach this view.
        NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: nil)
        if let window { NotificationCenter.default.addObserver(self, selector: #selector(windowResignedKey), name: NSWindow.didResignKeyNotification, object: window) }
    }
    @objc private func windowResignedKey() { releaseKeys() }

    // ----- for the model (and tests that drive the view) -----

    func send(_ messages: [[String: Any]]) {
        guard let handle, let data = try? JSONSerialization.data(withJSONObject: messages), let text = String(data: data, encoding: .utf8) else { return }
        rt_send(handle, text)
    }
    func pointer(u: Double, v: Double, button: Int? = nil, down: Bool = false) {
        guard let handle else { return }
        rt_pointer(handle, Float(u), Float(v))
        if let button { rt_button(handle, UInt8(button), down) }
    }
    func wheel(_ notches: Double) { if let handle { rt_wheel(handle, Float(notches)) } }
    func key(_ name: String, down: Bool) {
        guard let handle else { return }
        if down { held.insert(name) } else { held.remove(name) }
        let code = name.count == 1 ? (name.first!.isNumber ? "Digit\(name)" : "Key\(name)") : name
        rt_key(handle, code, name, down)
    }
    func snapshot(to path: String) { if let handle { rt_snapshot(handle, path) } }
    func reload(_ bundle: String) { if let handle { rt_reload(handle, bundle) } }
    /// Content frames a second, render scale (0: dynamic) and the most bounces (the engine's frame governor works within them).
    func quality(fps: Int, scale: Double, bounces: Int) { if let handle { rt_quality(handle, UInt32(fps), Float(scale), UInt32(bounces)) } }
    /// Pictures for a `StreamTexture` in the scene (an in-scene screen, a camera feed): RGBA8, copied before it returns.
    func stream(_ name: String, width: Int, height: Int, rgba: Data) {
        guard let handle else { return }
        rgba.withUnsafeBytes { raw in
            if let base = raw.baseAddress { rt_stream(handle, name, UInt32(width), UInt32(height), base.assumingMemoryBound(to: UInt8.self), raw.count) }
        }
    }
}

struct RenderView: NSViewRepresentable {
    let view: RenderNSView
    func makeNSView(context: Context) -> RenderNSView { view }
    func updateNSView(_ nsView: RenderNSView, context: Context) {}
}
