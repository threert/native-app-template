// The app: one window, the 3D view under everything, a status bar at the top left, the scene's HUD over the view and
// the side panel (agent, code, console) on the right.
import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in Model.shared.start() }
    }
    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { Model.shared.stop() }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct ThreeRTApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = Model.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .frame(minWidth: 960, minHeight: 600)
                .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 880)
        .commands {
            CommandGroup(after: .sidebar) {
                Button(model.showPanel ? "Hide Panel" : "Show Panel") { withAnimation(.easeOut(duration: 0.2)) { model.showPanel.toggle() } }
                    .keyboardShortcut("\\", modifiers: .command)
                Button("Agent") { model.showPanel = true; model.tab = "agent" }.keyboardShortcut("1", modifiers: .command)
                Button("Code") { model.showPanel = true; model.tab = "code" }.keyboardShortcut("2", modifiers: .command)
                Button("Console") { model.showPanel = true; model.tab = "console"; model.unseenErrors = 0 }.keyboardShortcut("3", modifiers: .command)
                Divider()
                Button("Save Snapshot to Desktop") { model.snapshotToDesktop() }.keyboardShortcut("s", modifiers: [.command, .shift])
                Button("Rebuild Scene") { model.send("scene.build") }.keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: Model
    static let panelWidth: CGFloat = 460
    /// Wider on the Code tab: code lines are long.
    private var panelWidth: CGFloat { model.tab == "code" ? 600 : RootView.panelWidth }

    var body: some View {
        ZStack(alignment: .topLeading) {
            RenderView(view: model.view).ignoresSafeArea()
            if !model.ready && model.fatal == nil {
                Loading().allowsHitTesting(false)
            }
            HUDView()
                .padding(.trailing, model.showPanel ? panelWidth + 24 : 0)
                .allowsHitTesting(false)
            StatusBar().padding(.leading, 78).padding(.top, 10)
            if let fatal = model.fatal {
                VStack(alignment: .leading, spacing: 8) {
                    Text("The scene could not start").font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.ink)
                    Text(fatal).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Theme.bad).textSelection(.enabled).lineLimit(12)
                    Button("Ask the agent to fix it") { model.showPanel = true; model.tab = "agent"; model.askToFix() }.buttonStyle(QuietButton(prominent: true))
                }
                .padding(16).frame(maxWidth: 520, alignment: .leading).glass()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.trailing, model.showPanel ? panelWidth + 24 : 0)
            }
            if model.showPanel {
                SidePanel()
                    .frame(width: panelWidth)
                    .animation(.easeOut(duration: 0.18), value: model.tab)
                    .padding(.trailing, 12).padding(.top, 12).padding(.bottom, 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .ignoresSafeArea()
    }
}

/// Top left: the build, the frame rate, and the panel's switch.
struct StatusBar: View {
    @EnvironmentObject var model: Model
    var body: some View {
        HStack(spacing: 8) {
            if !model.buildOK {
                Chip(text: "build failed", tint: Theme.bad)
            } else if model.reloading {
                HStack(spacing: 5) { ProgressView().controlSize(.mini); Text("reloading").font(.system(size: 10.5, weight: .semibold)) }.foregroundStyle(Theme.dim)
            } else if model.ready {
                Chip(text: "live", tint: Theme.good)
            }
            if let fps = model.stats["fps"], model.ready {
                Chip(text: String(format: "%.0f fps", fps), tint: Theme.dim, mono: true)
                    .help(String(format: "GPU %.1f ms · scale %.2f · %.0f spp · %.0f bounces · %.0f×%.0f · %@",
                                 model.stats["gpuMs"] ?? 0, model.stats["scale"] ?? 0, model.stats["spp"] ?? 0, model.stats["bounces"] ?? 0,
                                 model.stats["width"] ?? 0, model.stats["height"] ?? 0, model.adapter))
            }
            if model.sidecarStatus != "connected" && model.sidecarStatus != "starting" {
                Text(model.sidecarStatus).font(.system(size: 11)).foregroundStyle(Theme.warn).lineLimit(2)
            }
            IconButton(symbol: "camera", help: "Save a snapshot to the Desktop (⇧⌘S)") { model.snapshotToDesktop() }
            IconButton(symbol: "sidebar.right", help: "Show or hide the panel (⌘\\)", active: model.showPanel) {
                withAnimation(.easeOut(duration: 0.2)) { model.showPanel.toggle() }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .glass(12)
    }
}

/// The scene's HUD (`hud.set`): text and list items at their anchors, the message in the middle.
struct HUDView: View {
    @EnvironmentObject var model: Model
    private let anchors: [(String, Alignment)] = [
        ("top-left", .topLeading), ("top", .top), ("top-right", .topTrailing), ("left", .leading), ("center", .center),
        ("right", .trailing), ("bottom-left", .bottomLeading), ("bottom", .bottom), ("bottom-right", .bottomTrailing),
    ]
    var body: some View {
        ZStack {
            ForEach(anchors, id: \.0) { anchor, alignment in
                let items = model.hud.filter { $0.anchor == anchor }
                if !items.isEmpty {
                    VStack(alignment: horizontal(alignment), spacing: 4) {
                        ForEach(items) { item in
                            VStack(alignment: horizontal(alignment), spacing: 1) {
                                if !item.label.isEmpty { Text(item.label.uppercased()).font(.system(size: 9.5, weight: .bold)).tracking(0.8).foregroundStyle(Theme.faint) }
                                Text(item.text).font(.system(size: item.large ? 22 : 12.5, weight: item.large ? .bold : .medium)).foregroundStyle(tone(item.tone))
                            }
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.black.opacity(0.38)))
                    .padding(.top, anchor.hasPrefix("top") ? 60 : 18).padding(.horizontal, 18).padding(.bottom, 18)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
                }
            }
            if let message = model.hudMessage {
                VStack(spacing: 6) {
                    Text(message.title).font(.system(size: 30, weight: .bold)).foregroundStyle(Theme.ink)
                    if !message.subtitle.isEmpty { Text(message.subtitle).font(.system(size: 14)).foregroundStyle(Theme.dim) }
                }
                .shadow(color: .black.opacity(0.6), radius: 10)
            }
        }
    }
    private func horizontal(_ a: Alignment) -> HorizontalAlignment {
        a == .topLeading || a == .leading || a == .bottomLeading ? .leading : a == .topTrailing || a == .trailing || a == .bottomTrailing ? .trailing : .center
    }
    private func tone(_ t: String) -> Color {
        switch t {
        case "good": return Theme.good
        case "warn": return Theme.warn
        case "bad": return Theme.bad
        case "accent": return Theme.accent
        case "dim": return Theme.dim
        default: return Theme.ink
        }
    }
}

struct Loading: View {
    @EnvironmentObject var model: Model
    var body: some View {
        ZStack {
            Color.black
            VStack(spacing: 12) {
                ProgressView().controlSize(.large)
                Text(model.buildOK ? "Building the scene…" : "The scene does not build yet").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
                Text(model.buildOK ? "The first start compiles the engine's GPU pipelines (a few seconds)" : "See the console, or ask the agent to fix it")
                    .font(.system(size: 12)).foregroundStyle(Theme.dim)
            }
        }
    }
}
