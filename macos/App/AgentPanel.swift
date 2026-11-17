// The side panel: the conversation with the coding agent, the scene's code and the console.
import AppKit
import SwiftUI

struct SidePanel: View {
    @EnvironmentObject var model: Model
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                ForEach([("agent", "Agent"), ("code", "Code"), ("console", "Console")], id: \.0) { item in
                    Button { model.tab = item.0; if item.0 == "console" { model.unseenErrors = 0 } } label: {
                        HStack(spacing: 4) {
                            Text(item.1).font(.system(size: 12, weight: .semibold))
                            if item.0 == "console" && (model.unseenErrors > 0 || !model.buildOK) { Circle().fill(Theme.bad).frame(width: 6, height: 6) }
                        }
                        .foregroundStyle(model.tab == item.0 ? Theme.ink : Theme.dim)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 8).fill(model.tab == item.0 ? Color.white.opacity(0.1) : .clear))
                        .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                Spacer()
                if model.tab == "agent" { AgentPicker() }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            Rectangle().fill(Theme.line).frame(height: 1)
            Group {
                switch model.tab {
                case "code": CodeView()
                case "console": ConsoleView()
                default: ChatView()
                }
            }
            .frame(maxHeight: .infinity)
        }
        .glass()
    }
}

struct AgentPicker: View {
    @EnvironmentObject var model: Model
    var body: some View {
        Menu {
            ForEach(model.agents) { agent in
                Button { model.send("agent.select", ["agent": agent.id]) } label: {
                    Text(agent.installed ? "\(agent.name)  \(agent.version)" : "\(agent.name) (not installed)")
                    if agent.id == model.agent { Image(systemName: "checkmark") }
                }.disabled(!agent.installed)
            }
            Divider()
            Button("New conversation") { model.send("agent.new"); model.chat = [] }
        } label: {
            HStack(spacing: 4) {
                Circle().fill(model.agentStatus == "error" ? Theme.bad : model.agentStatus == "idle" ? Theme.dim : Theme.good).frame(width: 6, height: 6)
                Text(model.agents.first(where: { $0.id == model.agent })?.name ?? (model.agent == "codex" ? "Codex" : "Claude Code")).font(.system(size: 11, weight: .semibold))
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
            }.foregroundStyle(Theme.dim)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }
}

struct ChatView: View {
    @EnvironmentObject var model: Model
    @State private var draft = ""
    @FocusState private var focused: Bool
    private let suggestions = [
        "Add a reading lamp on the table that I can switch with the L key",
        "Make the orbs leave a short trail of sparks as they roll",
        "Turn it into a rainy evening: dim blue light through the skylight",
    ]
    private var selectedInfo: AgentInfo? { model.agents.first(where: { $0.id == model.agent }) }
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 9) {
                        if model.chat.isEmpty { Welcome(suggestions: suggestions, info: selectedInfo) { model.prompt($0) } }
                        ForEach(model.chat) { item in ChatRow(item: item).id(item.id) }
                        if model.agentStatus == "working" || model.agentStatus == "starting" {
                            HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(model.agentStatus == "starting" ? "Starting the agent…" : "Working…").font(.system(size: 11)).foregroundStyle(Theme.dim) }.id("busy")
                        }
                        if let error = model.agentError, model.agentStatus == "error" {
                            Text(error).font(.system(size: 11)).foregroundStyle(Theme.bad).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.chat.count) { _, _ in withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: model.chat.last?.text.count ?? 0) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            if !model.buildOK, let first = model.problems.first {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warn).font(.system(size: 11))
                    Text("\(first.file):\(first.line) \(first.message)").font(.system(size: 11)).foregroundStyle(Theme.ink).lineLimit(2)
                    Spacer()
                    Button("Fix it") { model.askToFix() }.buttonStyle(QuietButton(tint: Theme.warn))
                }
                .padding(.horizontal, 12).padding(.vertical, 8).background(Theme.warn.opacity(0.08))
            }
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask the agent to change the scene…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 13)).lineLimit(1...6).focused($focused)
                    .onSubmit { submit() }
                if model.agentStatus == "working" || model.agentStatus == "waiting" || model.agentStatus == "starting" {
                    Button { model.send("agent.cancel") } label: { Image(systemName: "stop.fill").font(.system(size: 11)).frame(width: 26, height: 26).background(Circle().fill(Color.white.opacity(0.12))) }
                        .buttonStyle(.plain).foregroundStyle(Theme.ink).help("Stop")
                } else {
                    let empty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    Button { submit() } label: { Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).frame(width: 26, height: 26).background(Circle().fill(empty ? Color.white.opacity(0.1) : Theme.accent)) }
                        .buttonStyle(.plain).foregroundStyle(empty ? Theme.faint : .black).disabled(empty)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }
    private func submit() {
        model.prompt(draft)
        draft = ""
    }
}

struct Welcome: View {
    let suggestions: [String]
    let info: AgentInfo?
    let pick: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Change the scene by asking").font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.ink)
            Text("The agent edits the TypeScript in scene/. Every save is rebuilt and reloaded in the view within a second; it checks its own work with `scene check` and `scene shot`.")
                .font(.system(size: 11.5)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true).lineSpacing(2)
            if let info, !info.installed {
                Text(info.note.isEmpty ? "\(info.name) is not installed." : info.note).font(.system(size: 11.5)).foregroundStyle(Theme.warn).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(suggestions, id: \.self) { text in
                Button { pick(text) } label: {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "sparkles").font(.system(size: 10)).padding(.top, 2)
                        Text(text).font(.system(size: 11.5)).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.ink).padding(.horizontal, 10).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.fill))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line))
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
        }
        .padding(.bottom, 4)
    }
}

struct ChatRow: View {
    @EnvironmentObject var model: Model
    let item: ChatItem
    var body: some View {
        switch item.kind {
        case "user":
            HStack { Spacer(minLength: 40); Text(item.text).font(.system(size: 12.5)).foregroundStyle(Theme.ink).textSelection(.enabled)
                .padding(.horizontal, 11).padding(.vertical, 8).background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.accent.opacity(0.2))) }
        case "thought":
            Text(item.text.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 11).italic()).foregroundStyle(Theme.faint).lineLimit(3)
        case "tool":
            Button { if !item.path.isEmpty { model.open(file: item.path); model.tab = "code" } } label: {
                HStack(spacing: 7) {
                    Image(systemName: icon).font(.system(size: 10.5)).foregroundStyle(Theme.dim).frame(width: 14)
                    Text(item.title.isEmpty ? item.toolKind : item.title).font(.system(size: 11.5)).foregroundStyle(Theme.ink.opacity(0.85)).lineLimit(1).truncationMode(.middle)
                    if item.added + item.removed > 0 {
                        Text("+\(item.added)").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.good)
                        Text("−\(item.removed)").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.bad)
                    }
                    Spacer(minLength: 0)
                    switch item.status {
                    case "done": Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.good)
                    case "failed": Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.bad)
                    default: ProgressView().controlSize(.mini).scaleEffect(0.7)
                    }
                }
                .padding(.horizontal, 9).padding(.vertical, 5.5)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.fill))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(item.path.isEmpty ? item.title : "Open \(item.path)")
        case "plan":
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(item.entries.enumerated()), id: \.offset) { _, entry in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: entry.status == "completed" ? "checkmark.circle.fill" : entry.status == "in_progress" ? "circle.dotted" : "circle").font(.system(size: 10)).foregroundStyle(entry.status == "completed" ? Theme.good : Theme.dim).padding(.top, 1.5)
                        Text(entry.text).font(.system(size: 11.5)).foregroundStyle(entry.status == "completed" ? Theme.dim : Theme.ink).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(9).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line))
        case "permission":
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) { Image(systemName: "hand.raised.fill").font(.system(size: 10)).foregroundStyle(Theme.warn); Text(item.title.isEmpty ? "Permission needed" : item.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink) }
                if !item.text.isEmpty { Text(item.text).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.dim).lineLimit(4).textSelection(.enabled) }
                if !item.done {
                    HStack(spacing: 6) {
                        ForEach(item.options, id: \.id) { option in
                            Button(option.label) { model.send("agent.permission", ["id": item.id, "optionId": option.id]) }
                                .buttonStyle(QuietButton(tint: option.kind.hasPrefix("reject") ? Theme.bad : Theme.ink, prominent: option.kind == "allow_once"))
                        }
                    }
                }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 10).fill(Theme.warn.opacity(0.08))).overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.warn.opacity(0.3)))
        case "error":
            Text(item.text).font(.system(size: 11.5)).foregroundStyle(Theme.bad).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        case "notice":
            Text(item.text).font(.system(size: 11)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
        default:
            Markdown(text: item.text)
        }
    }
    private var icon: String {
        switch item.toolKind {
        case "read": return "doc.text"
        case "edit": return "pencil"
        case "execute": return "terminal"
        case "search": return "magnifyingglass"
        case "fetch": return "globe"
        case "think": return "brain"
        default: return "wrench.and.screwdriver"
        }
    }
}

/// The agent's prose: paragraphs with inline Markdown, fenced code as highlighted blocks.
struct Markdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                if block.code {
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(Highlighter.lines(block.text, language: "ts").enumerated()), id: \.offset) { _, line in
                                Text(line).font(.system(size: 11, design: .monospaced))
                            }
                        }
                        .textSelection(.enabled).padding(9)
                    }
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.35)))
                } else {
                    Text(inline(block.text)).font(.system(size: 12.5)).foregroundStyle(Theme.ink).lineSpacing(2.5).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
    private var blocks: [(code: Bool, text: String)] {
        var out: [(Bool, String)] = []
        var code = false
        var current: [String] = []
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
                if !joined.isEmpty { out.append((code, joined)) }
                current = []
                code.toggle()
            } else { current.append(line) }
        }
        let joined = current.joined(separator: "\n").trimmingCharacters(in: .newlines)
        if !joined.isEmpty { out.append((code, joined)) }
        return out.map { (code: $0.0, text: $0.1) }
    }
    private func inline(_ source: String) -> AttributedString {
        (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
    }
}
