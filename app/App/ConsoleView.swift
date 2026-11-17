// The console: the scene's console lines, the engine's errors and the build's problems.
import SwiftUI

struct ConsoleView: View {
    @EnvironmentObject var model: Model
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(model.console.count) lines").font(.system(size: 11)).foregroundStyle(Theme.faint)
                Spacer()
                Button("Clear") { model.console = [] }.buttonStyle(QuietButton(tint: Theme.dim))
            }.padding(.horizontal, 12).padding(.vertical, 8)
            Rectangle().fill(Theme.line).frame(height: 1)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(model.problems) { p in
                            Text("\(p.file):\(p.line)  \(p.message)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.bad)
                                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        }
                        ForEach(model.console) { line in
                            HStack(alignment: .top, spacing: 6) {
                                Text(line.source).font(.system(size: 9.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(line.source == "scene" ? Theme.accent : Theme.faint).frame(width: 46, alignment: .leading)
                                Text(line.text).font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(line.level == "error" ? Theme.bad : line.level == "warn" ? Theme.warn : Theme.ink.opacity(0.82))
                                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                            }.id(line.id)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.console.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
    }
}
