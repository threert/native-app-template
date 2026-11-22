// The app's state, and the switchboard between its three parts: the 3D view (core/, through RenderNSView), the sidecar
// (builds, the coding agent, the `scene` command line) and the SwiftUI panels.
//
//   sidecar  scene.built ──▶ model ──▶ view: rt_create / rt_reload
//   view     rt.reloaded / rt.error / log ──▶ model ──▶ sidecar: runtime.* (for `scene check`)
//   panels   agent.prompt / agent.permission ... ──▶ sidecar ──▶ Claude Code / Codex (ACP)
import AppKit
import Foundation
import SwiftUI

struct Problem: Identifiable, Hashable {
    let id = UUID()
    let file: String
    let line: Int
    let message: String
}

struct ConsoleLine: Identifiable {
    let id: Int
    let level: String
    let source: String
    let text: String
}

struct AgentInfo: Identifiable, Hashable {
    let id: String
    let name: String
    let installed: Bool
    let version: String
    let note: String
}

struct ChatItem: Identifiable {
    let id: String
    var kind: String
    var text: String
    var title: String
    var toolKind: String
    var status: String
    var path: String
    var added: Int
    var removed: Int
    var options: [(id: String, label: String, kind: String)]
    var entries: [(text: String, status: String)]
    var done: Bool

    init(_ j: [String: Any]) {
        id = j["id"] as? String ?? UUID().uuidString
        kind = j["kind"] as? String ?? "text"
        text = j["text"] as? String ?? ""
        title = j["title"] as? String ?? ""
        toolKind = j["toolKind"] as? String ?? ""
        status = j["status"] as? String ?? ""
        path = j["path"] as? String ?? ""
        let diff = j["diff"] as? [String: Any]
        added = diff?["added"] as? Int ?? 0
        removed = diff?["removed"] as? Int ?? 0
        if path.isEmpty, let p = diff?["path"] as? String { path = p }
        options = (j["options"] as? [[String: Any]] ?? []).map { (id: $0["id"] as? String ?? "", label: $0["label"] as? String ?? "", kind: $0["kind"] as? String ?? "") }
        entries = (j["entries"] as? [[String: Any]] ?? []).map { (text: $0["text"] as? String ?? "", status: $0["status"] as? String ?? "") }
        done = j["done"] as? Bool ?? false
    }
}

/// What the scene's HUD shows (`hud.set` in scene code; engine/docs/RUNTIME.md "HUD"). The app draws text items,
/// lists and the centre message.
struct HudItem: Identifiable {
    let id: Int
    let anchor: String
    let label: String
    let text: String
    let tone: String
    let large: Bool
}

@MainActor
final class Model: ObservableObject {
    static let shared = Model()

    let view = RenderNSView()
    private let sidecar = Sidecar()

    // The view
    @Published var ready = false
    @Published var fatal: String?
    @Published var adapter = ""
    @Published var stats: [String: Double] = [:]
    /// scene/app.json's "panel": the agent panel's words for this app.
    @Published var panel = PanelText()
    @Published var hud: [HudItem] = []
    @Published var hudMessage: (title: String, subtitle: String)?

    // The scene's builds
    @Published var sidecarStatus = "starting"
    @Published var buildOK = true
    @Published var buildSeq = 0
    @Published var buildMs = 0
    @Published var problems: [Problem] = []
    @Published var reloading = false
    @Published var lastReload: Date?

    // The console
    @Published var console: [ConsoleLine] = []
    @Published var unseenErrors = 0
    private var lineSerial = 0

    // The agent
    @Published var agents: [AgentInfo] = []
    @Published var agent = "claude"
    @Published var agentStatus = "idle"
    @Published var agentError: String?
    @Published var chat: [ChatItem] = []

    // The panel and the code viewer
    /// The side panel (agent, code, console): hidden until asked for (⌘\, the toolbar button, ⌘1–3).
    @Published var showPanel = false
    @Published var tab = "agent"
    @Published var files: [String] = []
    @Published var openFile: String?
    @Published var fileText = ""
    /// The open file's lines, highlighted.
    @Published var fileLines: [AttributedString] = []
    /// Lines (0-based) of the open file that changed in its last change on disk.
    @Published var changedLines: Set<Int> = []
    @Published var followAgent = true
    private var fileTexts: [String: String] = [:]

    /// The newest build sent to the view (the view answers by bundle: rt.ready / rt.reloaded / rt.error "reload").
    private var startedSeq = 0
    private var startedBundle: String?
    private var snapshots: [String: Int] = [:]
    private var windowShots: [String: (id: Int, path: String)] = [:]
    private var logBatch: [[String: Any]] = []

    func start() {
        view.onPosts = { [weak self] posts in self?.posts(posts) }
        sidecar.onMessage = { [weak self] message in self?.receive(message) }
        sidecar.onStatus = { [weak self] status in self?.sidecarStatus = status }
        sidecar.start()
        refreshFiles()
        if openFile == nil { open(file: files.first(where: { $0 == "main.game.ts" }) ?? files.first) }
    }

    func stop() {
        view.stop()
        sidecar.stop()
    }

    func send(_ type: String, _ fields: [String: Any] = [:]) {
        var message = fields
        message["t"] = type
        sidecar.send(message)
    }

    // ----- from the sidecar -----

    private func receive(_ m: [String: Any]) {
        switch m["t"] as? String ?? "" {
        case "state": state(m)
        case "scene.built":
            guard let bundle = m["bundle"] as? String, let seq = m["seq"] as? Int else { return }
            run(bundle: bundle, seq: seq)
        case "scene.files":
            refreshFiles()
            let paths = m["paths"] as? [String] ?? []
            if let file = openFile, paths.contains(file) || !files.contains(file) { reloadOpenFile() }
        case "agent.item":
            guard let j = m["item"] as? [String: Any] else { return }
            let item = ChatItem(j)
            if let i = chat.firstIndex(where: { $0.id == item.id }) { chat[i] = item } else { chat.append(item) }
            // The code viewer follows the file the agent is changing.
            if followAgent, item.kind == "tool", item.toolKind == "edit", !item.path.isEmpty, files.contains(item.path), item.path != openFile {
                open(file: item.path)
            }
        case "agent.delta":
            guard let id = m["id"] as? String, let text = m["text"] as? String, let i = chat.firstIndex(where: { $0.id == id }) else { return }
            chat[i].text += text
        case "agent.history":
            chat = (m["items"] as? [[String: Any]] ?? []).map(ChatItem.init)
        case "app.snapshot":
            guard let id = m["id"] as? Int, let path = m["path"] as? String else { return }
            let wait = m["wait"] as? Double ?? 1
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                self?.snapshots[path] = id
                self?.view.snapshot(to: path)
            }
        case "app.shot":
            // The whole window, composed offscreen (works with the display asleep): the traced frame under the panels.
            guard let id = m["id"] as? Int, let path = m["path"] as? String else { return }
            let frame = NSTemporaryDirectory() + "rt-window-\(id).png"
            windowShots[frame] = (id, path)
            DispatchQueue.main.asyncAfter(deadline: .now() + (m["wait"] as? Double ?? 0.5)) { [weak self] in self?.view.snapshot(to: frame) }
        case "app.send":
            view.send(m["messages"] as? [[String: Any]] ?? [])
        case "app.pointer":
            let u = m["u"] as? Double ?? 0.5, v = m["v"] as? Double ?? 0.5
            if m["click"] as? Bool == true {
                view.pointer(u: u, v: v, button: 0, down: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in self?.view.pointer(u: u, v: v, button: 0, down: false) }
            } else {
                view.pointer(u: u, v: v, button: m["button"] as? Int, down: m["down"] as? Bool ?? false)
            }
            answer(m)
        case "app.key":
            // (`hold`: seconds the key stays down; a tap otherwise.)
            let key = m["key"] as? String ?? ""
            view.key(key, down: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + (m["hold"] as? Double ?? 0.08)) { [weak self] in self?.view.key(key, down: false) }
            answer(m)
        case "app.wheel":
            view.wheel(m["notches"] as? Double ?? 1)
            answer(m)
        case "app.prompt":
            // As if typed into the chat (tests drive the agent with it).
            showPanel = true
            tab = "agent"
            prompt(m["text"] as? String ?? "")
            answer(m)
        case "app.panel":
            if let show = m["show"] as? Bool { showPanel = show }
            if let tab = m["tab"] as? String { self.tab = tab }
            if let file = m["file"] as? String { open(file: file) }
            answer(m)
        case "error":
            addLine(level: "error", source: "sidecar", text: m["message"] as? String ?? "")
        default:
            // A request this app does not know is answered at once, so its caller does not wait for nothing.
            if let type = m["t"] as? String, type.hasPrefix("app.") { answer(m, ["error": "unknown request \(type)"]) }
        }
    }

    private func answer(_ m: [String: Any], _ fields: [String: Any] = [:]) {
        guard let id = m["id"] else { return }
        var reply = fields
        reply["id"] = id
        send("answer", reply)
    }

    private func state(_ m: [String: Any]) {
        if let text = m["panel"] as? [String: Any] { panel = PanelText(text) }
        if let scene = m["scene"] as? [String: Any], let build = scene["build"] as? [String: Any] {
            buildOK = build["ok"] as? Bool ?? true
            buildSeq = build["seq"] as? Int ?? 0
            buildMs = build["ms"] as? Int ?? 0
            problems = (build["problems"] as? [[String: Any]] ?? []).map {
                Problem(file: $0["file"] as? String ?? "", line: $0["line"] as? Int ?? 0, message: $0["message"] as? String ?? "")
            }
            // A sidecar that was running before the app connected: run its last good build.
            if !ready, fatal == nil, startedSeq == 0, let bundle = build["bundle"] as? String, let seq = build["seq"] as? Int, buildOK {
                run(bundle: bundle, seq: seq)
            }
        }
        if let a = m["agent"] as? [String: Any] {
            agent = a["selected"] as? String ?? agent
            agentStatus = a["status"] as? String ?? "idle"
            agentError = a["error"] as? String
            agents = (a["agents"] as? [[String: Any]] ?? []).map {
                AgentInfo(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "", installed: $0["installed"] as? Bool ?? false,
                          version: $0["version"] as? String ?? "", note: $0["note"] as? String ?? "")
            }
        }
    }

    /// Runs a build: the first one starts the view, later ones reload it in place.
    private func run(bundle: String, seq: Int) {
        if seq <= startedSeq && view.handle != nil { return }
        if view.handle == nil || fatal != nil {
            if view.handle != nil { view.stop() }
            fatal = nil
            ready = false
            startedSeq = seq
            startedBundle = bundle
            view.start(bundle: bundle)
        } else {
            startedSeq = seq
            startedBundle = bundle
            reloading = true
            view.reload(bundle)
        }
    }

    // ----- from the view -----

    private func posts(_ list: [[String: Any]]) {
        for p in list {
            switch p["t"] as? String ?? "" {
            case "rt.ready":
                ready = true
                adapter = p["adapter"] as? String ?? ""
                send("runtime.reloaded", ["bundle": p["bundle"] as? String ?? ""])
                lastReload = Date()
            case "rt.fatal":
                let message = p["message"] as? String ?? "the renderer could not start"
                fatal = message
                addLine(level: "error", source: "engine", text: message)
                send("runtime.error", ["where": "reload", "message": message, "bundle": startedBundle ?? ""])
            case "rt.reloaded":
                lastReload = Date()
                let bundle = p["bundle"] as? String ?? ""
                if bundle == startedBundle { reloading = false }
                send("runtime.reloaded", ["bundle": bundle])
                addLine(level: "info", source: "app", text: "reloaded the scene")
            case "rt.error":
                let place = p["where"] as? String ?? "?"
                let message = p["message"] as? String ?? ""
                addLine(level: "error", source: place, text: message)
                var report: [String: Any] = ["where": place, "message": message]
                if place == "reload", let bundle = p["bundle"] as? String {
                    if bundle == startedBundle { reloading = false }
                    report["bundle"] = bundle
                }
                send("runtime.error", report)
            case "rt.stats":
                var s: [String: Double] = [:]
                for (k, v) in p { if let n = v as? Double { s[k] = n } else if let n = v as? Int { s[k] = Double(n) } }
                stats = s
                // (The sidecar keeps them for `scene state` / `scene check`: the agent sees what its change costs.)
                send("runtime.stats", ["stats": s])
            case "rt.snapshot":
                if let frame = p["path"] as? String, let shot = windowShots.removeValue(forKey: frame) {
                    let size = WindowShot.compose(view: view, frame: frame, to: shot.path)
                    send("answer", ["id": shot.id, "path": shot.path, "width": size.width, "height": size.height])
                } else if let path = p["path"] as? String, let id = snapshots.removeValue(forKey: path) {
                    send("answer", ["id": id, "path": path, "width": p["width"] as? Int ?? 0, "height": p["height"] as? Int ?? 0])
                }
            case "log":
                let level = p["level"] as? String ?? "log"
                let text = p["text"] as? String ?? ""
                addLine(level: level, source: "scene", text: text)
                logBatch.append(["level": level, "text": text])
            case "hud":
                showHud(p["hud"] as? [String: Any] ?? [:])
            default: break
            }
        }
        if !logBatch.isEmpty {
            send("runtime.logs", ["lines": logBatch])
            logBatch = []
        }
    }

    private func showHud(_ h: [String: Any]) {
        var items: [HudItem] = []
        for (i, item) in (h["items"] as? [[String: Any]] ?? []).enumerated() {
            let anchor = item["anchor"] as? String ?? "top-left"
            switch item["type"] as? String {
            case "text":
                items.append(HudItem(id: i * 100, anchor: anchor, label: item["label"] as? String ?? "", text: item["text"] as? String ?? "",
                                     tone: item["tone"] as? String ?? "default", large: item["size"] as? String == "large"))
            case "list":
                for (j, line) in (item["lines"] as? [Any] ?? []).enumerated() {
                    let text = (line as? String) ?? ((line as? [String: Any])?["text"] as? String) ?? ""
                    let tone = ((line as? [String: Any])?["tone"] as? String) ?? "default"
                    items.append(HudItem(id: i * 100 + j, anchor: anchor, label: "", text: text, tone: tone, large: false))
                }
            default: break
            }
        }
        hud = items
        if let m = h["message"] as? [String: Any], let title = m["title"] as? String {
            hudMessage = (title, m["subtitle"] as? String ?? "")
        } else { hudMessage = nil }
    }

    func addLine(level: String, source: String, text: String) {
        lineSerial += 1
        console.append(ConsoleLine(id: lineSerial, level: level, source: source, text: text))
        if console.count > 1000 { console.removeFirst(console.count - 1000) }
        if level == "error" && tab != "console" { unseenErrors += 1 }
    }

    // ----- the agent -----

    func prompt(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        send("agent.prompt", ["text": trimmed])
    }

    /// Asks the agent to fix what the build or the view reports.
    func askToFix() {
        var lines = problems.prefix(5).map { "\($0.file):\($0.line) \($0.message)" }
        lines += console.suffix(30).filter { $0.level == "error" }.suffix(3).map { "[\($0.source)] \($0.text)" }
        prompt("The scene has a problem. Run `scene check`, find the cause and fix it.\n\n" + lines.joined(separator: "\n"))
    }

    // ----- the code viewer -----

    func refreshFiles() {
        let root = URL(fileURLWithPath: Paths.scene)
        var found: [String] = []
        if let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]) {
            for case let url as URL in e {
                if url.pathComponents.contains("node_modules") { e.skipDescendants(); continue }
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
                guard ["ts", "js", "json", "md", "wgsl"].contains(url.pathExtension) else { continue }
                found.append(String(url.path.dropFirst(root.path.count + 1)))
            }
        }
        // The entry first, then the rest by folder and name.
        files = found.sorted { a, b in
            if a == "main.game.ts" { return true }
            if b == "main.game.ts" { return false }
            let (da, db) = (a.contains("/"), b.contains("/"))
            return da == db ? a.localizedStandardCompare(b) == .orderedAscending : !da
        }
    }

    func open(file: String?) {
        guard let file else { return }
        openFile = file
        let text = (try? String(contentsOfFile: Paths.scene + "/" + file, encoding: .utf8)) ?? ""
        fileTexts[file] = text
        fileText = text
        fileLines = Highlighter.lines(text, language: (file as NSString).pathExtension)
        changedLines = []
    }

    /// The open file changed on disk: show the new text, its changed lines marked.
    private func reloadOpenFile() {
        guard let file = openFile else { return }
        let text = (try? String(contentsOfFile: Paths.scene + "/" + file, encoding: .utf8)) ?? ""
        guard text != fileText else { return }
        changedLines = LineDiff.changed(old: fileTexts[file] ?? fileText, new: text)
        fileTexts[file] = text
        fileText = text
        fileLines = Highlighter.lines(text, language: (file as NSString).pathExtension)
    }

    func reveal(file: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: Paths.scene + "/" + file)])
    }

    func snapshotToDesktop() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "ThreeRT"
        let path = NSHomeDirectory() + "/Desktop/\(name) \(formatter.string(from: Date())).png"
        view.snapshot(to: path)
        addLine(level: "info", source: "app", text: "snapshot: \(path)")
    }
}

/// The agent panel's words for this app (scene/app.json "panel"; these until it is read).
struct PanelText {
    var title = "Change the scene by asking"
    var intro = "The agent edits the TypeScript in scene/. Every save is rebuilt and reloaded in the view within a second."
    var placeholder = "Ask the agent to change the scene…"
    var suggestions: [String] = []
    init() {}
    init(_ j: [String: Any]) {
        title = j["title"] as? String ?? title
        intro = j["intro"] as? String ?? intro
        placeholder = j["placeholder"] as? String ?? placeholder
        suggestions = j["suggestions"] as? [String] ?? []
    }
}

/// Which lines of `new` are not in the longest common subsequence of the two texts' lines.
enum LineDiff {
    static func changed(old: String, new: String) -> Set<Int> {
        let a = old.components(separatedBy: "\n"), b = new.components(separatedBy: "\n")
        var start = 0
        while start < a.count && start < b.count && a[start] == b[start] { start += 1 }
        var end = 0
        while end < a.count - start && end < b.count - start && a[a.count - 1 - end] == b[b.count - 1 - end] { end += 1 }
        let x = Array(a[start..<(a.count - end)]), y = Array(b[start..<(b.count - end)])
        if y.isEmpty { return [] }
        if x.isEmpty || x.count * y.count > 4_000_000 { return Set(start..<(start + y.count)) }
        // LCS table, then walk it back to mark the lines of `y` that are not shared.
        let n = x.count, m = y.count
        var table = [[Int32]](repeating: [Int32](repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                table[i][j] = x[i] == y[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var changed = Set<Int>()
        var i = 0, j = 0
        while j < m {
            if i < n && x[i] == y[j] { i += 1; j += 1 }
            else if i < n && table[i + 1][j] >= table[i][j + 1] { i += 1 }
            else { changed.insert(start + j); j += 1 }
        }
        return changed
    }
}
