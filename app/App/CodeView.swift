// The code viewer: the scene's files, highlighted, with line numbers. It reloads a file when it changes on disk and marks
// the lines that changed; with "Follow" on it opens the file the agent is editing.
import AppKit
import SwiftUI

struct CodeView: View {
    @EnvironmentObject var model: Model
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Menu {
                    ForEach(model.files, id: \.self) { file in
                        Button { model.open(file: file) } label: {
                            Text(file)
                            if file == model.openFile { Image(systemName: "checkmark") }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: icon(model.openFile ?? "")).font(.system(size: 11))
                        Text(model.openFile ?? "No file").font(.system(size: 12, weight: .semibold, design: .monospaced)).lineLimit(1)
                        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                    }.foregroundStyle(Theme.ink)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                Spacer()
                Toggle(isOn: $model.followAgent) { Text("Follow agent").font(.system(size: 11)) }
                    .toggleStyle(.checkbox).foregroundStyle(Theme.dim)
                    .help("Open the file the agent is editing")
                IconButton(symbol: "doc.on.doc", help: "Copy the file") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.fileText, forType: .string)
                }
                if let file = model.openFile {
                    IconButton(symbol: "folder", help: "Show in Finder") { model.reveal(file: file) }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(model.files, id: \.self) { file in
                        Button { model.open(file: file) } label: {
                            Text((file as NSString).lastPathComponent).font(.system(size: 10.5, weight: .medium, design: .monospaced))
                                .foregroundStyle(file == model.openFile ? Theme.ink : Theme.dim)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(RoundedRectangle(cornerRadius: 6).fill(file == model.openFile ? Color.white.opacity(0.12) : Theme.fill))
                        }.buttonStyle(.plain).help(file)
                    }
                }.padding(.horizontal, 12).padding(.bottom, 8)
            }
            Rectangle().fill(Theme.line).frame(height: 1)
            CodeLines(lines: model.fileLines, changed: model.changedLines, file: model.openFile ?? "")
        }
    }

    private func icon(_ file: String) -> String {
        switch (file as NSString).pathExtension {
        case "md": return "doc.richtext"
        case "json": return "curlybraces"
        default: return "chevron.left.forwardslash.chevron.right"
        }
    }
}

/// The lines of a file: a gutter of line numbers, a bar beside the lines that changed, the highlighted text.
struct CodeLines: View {
    let lines: [AttributedString]
    let changed: Set<Int>
    let file: String
    private let font = Font.system(size: 11.5, design: .monospaced)
    var body: some View {
        let gutter = CGFloat(max(String(lines.count).count, 2)) * 7.5 + 14
        ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        HStack(spacing: 0) {
                            Text("\(index + 1)").font(font).foregroundStyle(changed.contains(index) ? Theme.accent : Theme.faint)
                                .frame(width: gutter, alignment: .trailing).padding(.trailing, 8)
                            Rectangle().fill(changed.contains(index) ? Theme.accent : Color.clear).frame(width: 2)
                            Text(line.characters.isEmpty ? AttributedString(" ") : line).font(font)
                                .fixedSize(horizontal: true, vertical: false).padding(.leading, 10).padding(.trailing, 16)
                                .textSelection(.enabled)
                        }
                        .frame(height: 17, alignment: .leading)
                        .background(changed.contains(index) ? Theme.accent.opacity(0.09) : Color.clear)
                        .id(index)
                    }
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color.black.opacity(0.25))
            .onChange(of: changed) { _, now in
                if let first = now.min() { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(max(first - 4, 0), anchor: .top) } }
            }
            .onChange(of: file) { _, _ in proxy.scrollTo(0, anchor: .top) }
        }
    }
}
