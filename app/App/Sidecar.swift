// The sidecar (sidecar/src/main.ts, run by Bun): builds the scene on every change, bridges the coding agent and serves
// the agent's `scene` command line. The app starts it, reads its port from its first line of output and holds one
// WebSocket to it: JSON messages both ways (sidecar/src/server.ts lists them).
import Foundation

final class Sidecar: NSObject, URLSessionWebSocketDelegate {
    var onMessage: (([String: Any]) -> Void)?
    var onStatus: ((String) -> Void)?
    private var process: Process?
    private var stdinPipe: Pipe?
    private var socket: URLSessionWebSocketTask?
    private let queue: OperationQueue = { let q = OperationQueue(); q.maxConcurrentOperationCount = 1; q.qualityOfService = .userInitiated; return q }()
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: queue)
    private var url: URL?
    private var closed = false
    private var buffer = Data()

    func start() {
        let env = ProcessInfo.processInfo.environment
        // A sidecar started by hand (`bun sidecar/src/main.ts`): RT_APP_SIDECAR=ws://127.0.0.1:<port>/app.
        if let existing = env["RT_APP_SIDECAR"], let url = URL(string: existing) {
            self.url = url
            connect()
            return
        }
        // An app opened from the Finder has a bare PATH: take the login shell's, where `bun`, `claude` and `codex` are.
        let path = Sidecar.shellPath(fallback: env["PATH"] ?? "/usr/bin:/bin")
        guard let bun = Paths.bun(searchPath: path) else {
            onStatus?("Bun was not found: install it from https://bun.sh (or set RT_APP_BUN)")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = [Paths.sidecar, "--with-parent"]
        process.currentDirectoryURL = URL(fileURLWithPath: Paths.root)
        var environment = env
        environment["RT_APP_ROOT"] = Paths.root
        environment["PATH"] = path
        process.environment = environment
        let out = Pipe(), input = Pipe()
        process.standardOutput = out
        process.standardInput = input
        process.standardError = FileHandle.standardError
        stdinPipe = input
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.output(data) }
        }
        process.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { if self?.closed == false { self?.onStatus?("The sidecar stopped (\(p.terminationStatus)): see the terminal's output") } }
        }
        do {
            try process.run()
            self.process = process
            onStatus?("starting")
        } catch {
            onStatus?("The sidecar did not start: \(error.localizedDescription)")
        }
    }

    /// The PATH of the user's login shell.
    private static func shellPath(fallback: String) -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-lic", "printf '%s' \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do {
            try p.run()
            let deadline = Date().addingTimeInterval(3)
            while p.isRunning && Date() < deadline { usleep(20_000) }
            if p.isRunning { p.terminate(); return fallback }
            let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let path = text.split(separator: "\n").last.map(String.init) ?? ""
            return path.contains("/") ? path + ":" + fallback : fallback
        } catch { return fallback }
    }

    private func output(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            if url == nil, let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let port = object["port"] as? Int {
                url = URL(string: "ws://127.0.0.1:\(port)/app")
                connect()
            } else if let text = String(data: line, encoding: .utf8) {
                FileHandle.standardError.write(("sidecar: " + text + "\n").data(using: .utf8)!)
            }
        }
    }

    private func connect() {
        guard let url, !closed else { return }
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 64 << 20
        socket = task
        task.resume()
        receive(task)
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.socket === task else { return }
            switch result {
            case .failure:
                task.cancel(with: .goingAway, reason: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self, self.socket === task, !self.closed else { return }
                    self.onStatus?("reconnecting")
                    self.connect()
                }
            case .success(let message):
                if case .string(let text) = message, let data = text.data(using: .utf8),
                   let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async { self.onMessage?(object) }
                }
                self.receive(task)
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        DispatchQueue.main.async { self.onStatus?("connected") }
    }

    func send(_ message: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { _ in }
    }

    func stop() {
        closed = true
        socket?.cancel(with: .goingAway, reason: nil)
        try? stdinPipe?.fileHandleForWriting.close()
        process?.terminate()
    }
}
