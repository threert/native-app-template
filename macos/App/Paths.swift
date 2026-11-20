// Where the app's parts are: the repository, for a build run from it (Info.plist `RTAppRoot`, set by project.yml), or
// RT_APP_ROOT. A packaged app would carry them in its Resources (README, "Shipping").
import Foundation

enum Paths {
    static let root: String = {
        if let env = ProcessInfo.processInfo.environment["RT_APP_ROOT"], !env.isEmpty { return env }
        if let plist = Bundle.main.object(forInfoDictionaryKey: "RTAppRoot") as? String, !plist.isEmpty,
           FileManager.default.fileExists(atPath: plist + "/sidecar/src/main.ts") {
            return URL(fileURLWithPath: plist).standardizedFileURL.path
        }
        return (Bundle.main.resourcePath ?? ".") + "/app"
    }()
    static var sidecar: String { root + "/sidecar/src/main.ts" }
    /// The scene's sources (what the code viewer shows and the agent edits); also the root its asset paths resolve against.
    static var scene: String { root + "/scene" }
    static var presets: String { root + "/engine/presets" }

    /// Bun, which runs the sidecar: RT_APP_BUN, else the first one found where installers put it.
    static func bun(searchPath: String) -> String? {
        if let env = ProcessInfo.processInfo.environment["RT_APP_BUN"], FileManager.default.isExecutableFile(atPath: env) { return env }
        let home = NSHomeDirectory()
        let dirs = searchPath.split(separator: ":").map(String.init) + [home + "/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        return dirs.map { $0 + "/bun" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}
