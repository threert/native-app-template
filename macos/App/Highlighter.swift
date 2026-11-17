// Syntax highlighting for the code viewer: a small tokenizer for TypeScript / JavaScript (and JSON, WGSL, Markdown well
// enough), line by line with the state that crosses lines (block comments, template strings). No dependencies; good for
// reading, not a parser.
import SwiftUI

enum Highlighter {
    enum Kind { case plain, keyword, string, number, comment, type, call, property, heading }

    static let palette: [Kind: Color] = [
        .plain: Color.white.opacity(0.86),
        .keyword: Color(red: 0.98, green: 0.49, blue: 0.64),
        .string: Color(red: 0.66, green: 0.86, blue: 0.52),
        .number: Color(red: 0.98, green: 0.69, blue: 0.42),
        .comment: Color.white.opacity(0.38),
        .type: Color(red: 0.46, green: 0.80, blue: 0.96),
        .call: Color(red: 0.96, green: 0.86, blue: 0.52),
        .property: Color(red: 0.80, green: 0.78, blue: 0.98),
        .heading: Color(red: 0.98, green: 0.74, blue: 0.42),
    ]

    static let keywords: Set<String> = [
        // TypeScript / JavaScript
        "import", "export", "from", "as", "default", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
        "switch", "case", "break", "continue", "new", "class", "extends", "implements", "interface", "type", "enum", "public", "private",
        "protected", "readonly", "static", "async", "await", "yield", "try", "catch", "finally", "throw", "typeof", "instanceof", "in",
        "of", "void", "delete", "this", "super", "null", "undefined", "true", "false", "keyof", "declare", "namespace", "satisfies",
        // WGSL
        "fn", "struct", "var", "let", "loop", "vec2", "vec3", "vec4", "f32", "u32", "i32", "bool",
    ]

    /// The text's lines, highlighted. `language` is the file's extension.
    static func lines(_ text: String, language: String) -> [AttributedString] {
        let source = text.components(separatedBy: "\n")
        if language == "md" { return source.map(markdown) }
        var state = State()
        return source.map { line(Array($0.unicodeScalars), &state) }
    }

    private struct State { var blockComment = false; var template = false }

    private static func line(_ s: [Unicode.Scalar], _ state: inout State) -> AttributedString {
        var out = AttributedString()
        var i = 0
        func emit(_ from: Int, _ to: Int, _ kind: Kind) {
            guard to > from else { return }
            var piece = AttributedString(String(String.UnicodeScalarView(s[from..<to])))
            piece.foregroundColor = palette[kind]
            if kind == .comment { piece.font = .system(size: 11.5, design: .monospaced).italic() }
            out += piece
        }
        func isIdent(_ c: Unicode.Scalar) -> Bool { c == "_" || c == "$" || CharacterSet.alphanumerics.contains(c) }
        var lastWord = ""
        while i < s.count {
            let c = s[i]
            if state.blockComment {
                let start = i
                while i < s.count && !(s[i] == "*" && i + 1 < s.count && s[i + 1] == "/") { i += 1 }
                if i < s.count { i += 2; state.blockComment = false }
                emit(start, i, .comment)
                continue
            }
            if state.template {
                let start = i
                while i < s.count && s[i] != "`" { if s[i] == "\\" { i += 1 }; i += 1 }
                if i < s.count { i += 1; state.template = false }
                emit(start, min(i, s.count), .string)
                continue
            }
            if c == "/" && i + 1 < s.count && s[i + 1] == "/" { emit(i, s.count, .comment); break }
            if c == "/" && i + 1 < s.count && s[i + 1] == "*" { state.blockComment = true; continue }
            if c == "`" { let start = i; i += 1; state.template = true
                while i < s.count && s[i] != "`" { if s[i] == "\\" { i += 1 }; i += 1 }
                if i < s.count { i += 1; state.template = false }
                emit(start, min(i, s.count), .string); continue }
            if c == "\"" || c == "'" {
                let start = i; i += 1
                while i < s.count && s[i] != c { if s[i] == "\\" { i += 1 }; i += 1 }
                i = min(i + 1, s.count)
                emit(start, i, .string); continue
            }
            if CharacterSet.decimalDigits.contains(c) && (i == 0 || !isIdent(s[i - 1])) {
                let start = i
                while i < s.count && (isIdent(s[i]) || s[i] == "." || ((s[i] == "-" || s[i] == "+") && (s[i - 1] == "e" || s[i - 1] == "E"))) { i += 1 }
                emit(start, i, .number); continue
            }
            if isIdent(c) {
                let start = i
                while i < s.count && isIdent(s[i]) { i += 1 }
                let word = String(String.UnicodeScalarView(s[start..<i]))
                var j = i
                while j < s.count && s[j] == " " { j += 1 }
                let afterDot = start > 0 && s[start - 1] == "."
                let kind: Kind
                if keywords.contains(word) && !afterDot { kind = .keyword }
                else if j < s.count && s[j] == "(" && lastWord != "function" { kind = .call }
                else if let first = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(first) { kind = .type }
                else if afterDot { kind = .property }
                else { kind = .plain }
                emit(start, i, kind)
                lastWord = word
                continue
            }
            let start = i
            i += 1
            emit(start, i, .plain)
        }
        return out
    }

    private static func markdown(_ text: String) -> AttributedString {
        var piece = AttributedString(text)
        if text.hasPrefix("#") {
            piece.foregroundColor = palette[.heading]
            piece.font = .system(size: 11.5, weight: .bold, design: .monospaced)
        } else if text.hasPrefix("```") || text.hasPrefix("    ") {
            piece.foregroundColor = palette[.string]
        } else {
            piece.foregroundColor = palette[.plain]
        }
        return piece
    }
}
