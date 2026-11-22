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

/// The file as an editor shows it: an AppKit text view (read-only, selectable, no wrapping: long lines scroll sideways)
/// beside a gutter of line numbers that scrolls up and down with it. A newly opened file starts at its top left; when
/// the file changes on disk, the view goes to the first changed line (a few lines of context above it) and marks the
/// changed lines.
struct CodeLines: NSViewRepresentable {
    let lines: [AttributedString]
    let changed: Set<Int>
    let file: String

    static let font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
    static let lineHeight: CGFloat = 17
    static let background = NSColor(red: 0.05, green: 0.05, blue: 0.06, alpha: 1)

    final class Coordinator {
        var file = ""
        var lines: [AttributedString] = []
        var changed: Set<Int> = []
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> CodePane { CodePane() }

    func updateNSView(_ pane: CodePane, context: Context) {
        let c = context.coordinator
        guard c.file != file || c.lines != lines || c.changed != changed else { return }
        let newFile = c.file != file
        let newMarks = c.changed != changed
        c.file = file
        c.lines = lines
        c.changed = changed
        let text = pane.text
        text.textStorage?.setAttributedString(Self.attributed(lines, markdown: (file as NSString).pathExtension == "md"))
        Self.mark(changed, in: text)
        pane.gutter.changed = changed
        pane.gutter.lineCount = lines.count
        pane.needsLayout = true
        if newFile {
            text.scroll(.zero)
        } else if newMarks, let first = changed.min() {
            text.scroll(NSPoint(x: 0, y: CGFloat(max(first - 4, 0)) * Self.lineHeight))
        }
        pane.gutter.needsDisplay = true
    }

    /// The highlighted lines as one AppKit string: the highlighter's colours, comments in italic, Markdown headings bold.
    static func attributed(_ lines: [AttributedString], markdown: Bool) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        let italic = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
        let bold = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .bold)
        let plain = NSColor(Highlighter.palette[.plain] ?? .white)
        for (i, line) in lines.enumerated() {
            for run in line.runs {
                let kind = run.foregroundColor
                let face = run.font == nil ? font : markdown && kind == Highlighter.palette[.heading] ? bold : kind == Highlighter.palette[.comment] ? italic : font
                let color = kind.map { NSColor($0) } ?? plain
                out.append(NSAttributedString(string: String(line[run.range].characters), attributes: [.font: face, .foregroundColor: color, .paragraphStyle: paragraph]))
            }
            if i < lines.count - 1 { out.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: paragraph])) }
        }
        return out
    }

    /// A faint band behind the lines that changed.
    static func mark(_ changed: Set<Int>, in text: NSTextView) {
        guard let layout = text.layoutManager, let storage = text.textStorage else { return }
        let whole = NSRange(location: 0, length: storage.length)
        layout.removeTemporaryAttribute(.backgroundColor, forCharacterRange: whole)
        guard !changed.isEmpty else { return }
        var line = 0
        (storage.string as NSString).enumerateSubstrings(in: whole, options: [.byLines, .substringNotRequired]) { _, _, enclosing, _ in
            if changed.contains(line) { layout.addTemporaryAttribute(.backgroundColor, value: NSColor(Theme.accent).withAlphaComponent(0.09), forCharacterRange: enclosing) }
            line += 1
        }
    }
}

/// The gutter on the left, the scrolling text on the right.
final class CodePane: NSView {
    let scroll = NSTextView.scrollableTextView()
    let text: NSTextView
    let gutter: LineGutter

    override init(frame: NSRect) {
        text = scroll.documentView as! NSTextView
        gutter = LineGutter(textView: text)
        super.init(frame: frame)
        scroll.drawsBackground = true
        scroll.backgroundColor = CodeLines.background
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        text.isEditable = false
        text.isSelectable = true
        text.isRichText = true
        text.drawsBackground = false
        text.font = CodeLines.font
        text.textContainerInset = NSSize(width: 6, height: 8)
        text.selectedTextAttributes = [.backgroundColor: NSColor(Theme.accent).withAlphaComponent(0.28)]
        // No wrapping: the container is as wide as the longest line, the view grows sideways with it.
        text.isHorizontallyResizable = true
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.widthTracksTextView = false
        text.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        addSubview(gutter)
        addSubview(scroll)
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(gutter, selector: #selector(LineGutter.redraw), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        let width = gutter.width
        gutter.frame = NSRect(x: 0, y: 0, width: width, height: bounds.height)
        scroll.frame = NSRect(x: width, y: 0, width: max(bounds.width - width, 0), height: bounds.height)
    }
}

/// Line numbers beside the text (changed lines in the accent colour, with a bar), in step with its scrolling.
final class LineGutter: NSView {
    var changed: Set<Int> = []
    var lineCount = 0
    var width: CGFloat { CGFloat(max(String(lineCount).count, 2)) * 7.5 + 20 }
    private weak var text: NSTextView?

    init(textView: NSTextView) {
        text = textView
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError("not used") }
    override var isFlipped: Bool { true }
    @objc func redraw() { needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        CodeLines.background.setFill()
        bounds.fill()
        guard let text, let layout = text.layoutManager, let container = text.textContainer, layout.numberOfGlyphs > 0 else { return }
        let visible = text.visibleRect
        let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
        // Nothing wraps, so each line fragment is a line; the first visible one's number is the newlines before it.
        let first = layout.characterIndexForGlyph(at: glyphs.location)
        var line = (text.string as NSString).substring(to: first).reduce(0) { $1 == "\n" ? $0 + 1 : $0 }
        let offset = text.textContainerInset.height - visible.minY
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        layout.enumerateLineFragments(forGlyphRange: glyphs) { frame, _, _, _, _ in
            let marked = self.changed.contains(line)
            let label = NSAttributedString(string: "\(line + 1)", attributes: [.font: font, .foregroundColor: marked ? NSColor(Theme.accent) : NSColor(Theme.faint)])
            let size = label.size()
            let y = frame.minY + offset
            label.draw(at: NSPoint(x: self.bounds.width - size.width - 10, y: y + (frame.height - size.height) / 2 + 1.5))
            if marked {
                NSColor(Theme.accent).setFill()
                NSRect(x: self.bounds.width - 2, y: y, width: 2, height: frame.height).fill()
            }
            line += 1
        }
    }
}
