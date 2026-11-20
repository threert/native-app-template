# Agent guide

**If you are the coding agent inside the app** (your working directory is `scene/`): follow `scene/AGENTS.md` and
change only files in `scene/`. The rest of this file is for working on the template itself.

## Working on the template

- Layout and message flow: `docs/ARCHITECTURE.md`. The engine is the `engine/` submodule (meshy-dev/ThreeRT); don't
  edit it here: engine changes go to that repository, then the submodule moves.
- Build and run: `bun tools/macos.ts --run` (Rust core, xcodegen, xcodebuild; it prints the .app and quits a copy
  that runs). `--no-core` skips the Rust build when only Swift changed. Run the binary in the .app's `Contents/MacOS`
  directly to see its stderr.
- With the app running, `.build/bin/scene check | shot | logs | state` drive it, and `scene app '<json>'` sends the
  window the requests tests use: `{"t":"app.pointer","u":0.5,"v":0.5,"click":true}` clicks in the view,
  `{"t":"app.key","key":"N"}` presses a key (`"hold": 1.2` keeps it down that many seconds), `{"t":"app.panel","tab":"code"}`
  switches the panel, `{"t":"app.prompt","text":"..."}` sends the agent a prompt as if typed, `{"t":"app.shot","path":"..."}`
  saves the whole window. (The sidecar takes requests only with its token: `.build/server.json`.)
- Offline stills without the app: `bun tools/still.ts out.png [--time 3] [--camera '{...}']`.
- Tests: `cd sidecar && bun test` (the agent bridge against a fake ACP agent, the permission policy);
  type-checks: `cd sidecar && bunx tsc -p .`, `sidecar/node_modules/.bin/tsc -p scene`.
- Swift: `macos/App/*.swift` (SwiftUI, macOS 14). `Model.swift` is the switchboard; `RenderView.swift` the Metal view
  and input; `Core.h` mirrors `core/src/lib.rs`'s C ABI: keep the two in step.
