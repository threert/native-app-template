# Architecture

Three processes' worth of parts, each in the language it is best at:

```
┌──────────────────── the macOS app (macos/, SwiftUI) ──────────────────────────┐
│  RenderView: a CAMetalLayer ──────────────┐        SidePanel: Agent · Code · Console
│  pointer, keys, resize                    │        HUD overlay (the scene's hud.set)
│                                           ▼
│  core/ (Rust static library, C ABI: macos/App/Core.h)
│    its own thread: ThreeRT LiveCore (path tracer, wgpu/Metal) + GameSession
│    (the scene's script in QuickJS, Rapier physics) + audio
│    commands in a channel ◀── rt_* calls      rt_poll ──▶ posts, logs, stats
└────────────────────────────────┬──────────────────────────────────────────────┘
                                 │ one WebSocket (JSON), ws://127.0.0.1:<port>/app
┌────────────────────────────────┴──── sidecar/ (Bun, TypeScript) ──────────────┐
│  scene.ts   watch scene/ ─▶ bundle.ts (Bun.build + the engine's SDK) ─▶ scene.built
│  agent/     ACP client ─▶ Claude Code / Codex (their ACP adapters, on stdio)
│             policy.ts: what the agent may do without asking; transcript.ts: the chat
│  server.ts  /app socket for the app; /api/* for the `scene` command line
│  cli.ts     `scene check | shot | logs | send | state` (on the agent's PATH)
└───────────────────────────────────────────────────────────────────────────────┘
                 scene/  ◀── the agent edits these files; the app reloads them
                 engine/ ◀── ThreeRT (git submodule): renderer, SDK, docs
```

## The view (core/)

`core/src/lib.rs` is the whole native side: about 500 lines on top of the engine's public API.

- `rt_create(layer, w, h, scale, bundle, assets, presets)` starts a thread that owns the GPU device, the surface on
  the app's `CAMetalLayer`, a `LiveCore` (the live path tracer) and a `GameSession` (the scene's script and physics).
- Every content frame: pending stream-texture pictures are written (`LiveCore::write_stream`), the frame's input goes
  to the script (`host_messages` with `InputTracker::message()`), the frame script runs (`GameSession::frame`), its
  posts are collected (sounds to the engine's mixer, everything else to the app), the frame is traced and blitted to
  the surface. A frame governor trades render scale, then samples per pixel, then bounces for the frame rate.
- The scene hears the view's shape: `launch {params: {width, height}}` after setup and `view {width, height}`
  after a resize (a scene that casts rays through the pointer needs the aspect).
- Calls from the app (`rt_pointer`, `rt_key`, `rt_send`, `rt_reload`, ...) are commands in a channel; the thread
  takes them between frames. Nothing the app calls waits for the GPU.
- `rt_poll` returns a JSON array of what happened since the last call: the scene's `host.post` messages (its `hud`,
  your own message types), its `console.*` lines (`log`), and the core's own `rt.ready`, `rt.fatal`, `rt.error`,
  `rt.reloaded`, `rt.stats`, `rt.snapshot`.
- `rt_reload(bundle)` opens a new build of the scene in a fresh runtime on the same view; if its setup throws, the
  old scene keeps running and `rt.error {where: "reload"}` says why.
- When the window is hidden or the display sleeps, the scene is still traced (more slowly), so snapshots and
  `scene check` work.

## The sidecar (sidecar/)

Bun runs it; the app starts it with `--with-parent` (it exits when the app's pipe closes) and reads its port from its
first line of output. Start one by hand with `bun sidecar/src/main.ts` and point the app at it with
`RT_APP_SIDECAR=ws://127.0.0.1:<port>/app` to debug it separately.

| Message | Direction | |
| --- | --- | --- |
| `state {scene: {build, loaded}, agent}` | sidecar → app | on connect and on every change |
| `scene.built {seq, bundle}` | sidecar → app | a build to run (`rt_reload`) |
| `scene.files {paths}` | sidecar → app | files changed on disk (the code viewer reloads, marks changed lines) |
| `app.snapshot`, `app.send`, `app.pointer`, `app.key`, `app.wheel`, `app.panel` `{id, ...}` | sidecar → app | requests of the command line / tests; answered with `answer {id, ...}` |
| `runtime.reloaded {seq}`, `runtime.error {where, message, seq?}`, `runtime.logs {lines}` | app → sidecar | what the view reports, for `scene check` |
| `agent.select`, `agent.prompt`, `agent.cancel`, `agent.permission`, `agent.new`, `agent.history` | app → sidecar | the chat panel |
| `agent.item`, `agent.delta`, `agent.turn`, `agent.history` | sidecar → app | the agent's transcript, streamed |

### The agent bridge (sidecar/src/agent/)

The bridge is an [Agent Client Protocol](https://agentclientprotocol.com) client (`@agentclientprotocol/sdk`). It
runs the official adapters, pinned in `adapters.ts`, which drive the coding agent the user already has:

| Agent | Adapter | Drives | Mode the bridge selects |
| --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp` | the user's `claude` (`CLAUDE_CODE_EXECUTABLE`) | `acceptEdits` |
| Codex | `@agentclientprotocol/codex-acp` | `codex app-server` of the user's `codex` (`CODEX_PATH`) | `workspace-write` |

The adapters are installed once into `.build/agents` with Bun (without their optional packages, the agents' own
binaries, which the user already has). One session per agent, kept between prompts; if the process dies the next
prompt starts another and resumes the session when the agent can.

The agent's own permission system decides first (Claude Code in `acceptEdits` lets edits and its own read-only
commands in the working directory through; Codex in `workspace-write` its sandbox). What it asks about comes to the
bridge, which answers by these rules (`policy.ts`) and turns everything else into a permission card in the chat:

- write files under `scene/` (not `.git`, `.claude`, `.codex`, `.mcp.json`, `node_modules` in it);
- read files in the repository and the engine;
- run `scene ...` and a short list of read-only commands (`ls`, `cat`, `grep`, `rg`, `sed -n`, `find` without
  `-exec`/`-delete`, ...) on paths it may read. Shell expansion, redirection and anything else are the user's call.

The same rules answer the agent's `fs/read_text_file` / `fs/write_text_file` requests. Every prompt gets a short
preamble (`<app>...</app>`): where the scene is, its last build's problems and recent runtime errors, and the
instruction to read `scene/AGENTS.md` and finish with `scene check`.

`RT_APP_ACP_LOG=/tmp/acp.log` writes every JSON-RPC message, the agents' stderr and the bridge's decisions to a file.
`RT_APP_CLAUDE_MODEL`, `RT_APP_CODEX_MODEL`, `RT_APP_CLAUDE_EFFORT`, `RT_APP_CODEX_EFFORT` pick models.

## Builds and reloads

`sidecar/src/bundle.ts` bundles `scene/main.game.ts` with `Bun.build` into one IIFE script for the engine's
QuickJS runtime: the scene's modules, `@threert/scene` and `@threert/gameplay` from `engine/packages` (an
`onResolve` plugin maps them), and the node host the renderer calls (`installNodeHost`). Each build gets its own file
(`.build/scene/scene-<seq>.js`), so the view never reads a bundle that is being written.

`scene check` (`Server.check`): build, type-check (`tsc -p scene/tsconfig.json`), wait until the app reports that it
runs this build (or failed to), watch a second of frames, then report build problems, type errors, runtime errors
and console errors. Exit code 0 only when all are clean.

## Adapting the template

- **Your own scene:** replace `scene/` (keep `main.game.ts` as the entry, `tsconfig.json`, `AGENTS.md`).
- **Your own messages:** the scene posts `host.post({ t: "my.thing", ... })`; handle it in `Model.posts(_:)`.
  The app sends `view.send([["t": "my.command", ...]])`; the scene listens with `host.on("my.command", ...)`.
- **A screen in the scene that shows your app's pixels:** a `StreamTexture("name", w, h)` on a material in the scene,
  `view.stream("name", width:height:rgba:)` from Swift (engine/docs/RUNTIME.md "Stream textures").
- **Another agent:** add an `AgentSpec` in `adapters.ts` (any agent with an ACP adapter) and its id in `index.ts`.
- **Name and icon:** `macos/project.yml` (`PRODUCT_NAME`, `PRODUCT_BUNDLE_IDENTIFIER`).
- **Another engine version:** `cd engine && git checkout <commit>`, then `bun tools/macos.ts`.

## Adding a platform

Everything but the shell is shared. A new platform (its own folder next to `macos/`) needs:

- **The view:** a native surface for the core. `core/src/lib.rs` makes its wgpu surface from a `CAMetalLayer`
  (`SurfaceTargetUnsafe::CoreAnimationLayer`); another platform passes its own handle (an HWND, a Wayland or X11
  window, an Android `ANativeWindow`) and `rt_create` grows a variant for it. The rest of the C ABI is the same.
- **The sidecar:** start `bun sidecar/src/main.ts --with-parent`, read `{"port": N}` from its first line, hold the
  WebSocket and speak the messages in the table above (`macos/App/Model.swift` is the reference: about 400 lines).
- **The panels:** the agent chat, the code viewer, the console and the HUD, in the platform's own UI framework.
  `macos/App/Highlighter.swift` is a dependency-free tokenizer that ports directly.
- **A build script** in `tools/` (`tools/macos.ts` for macOS) and a CI job.

## Shipping it

This is a development layout: the app finds the repository through `RTAppRoot` in its Info.plist and runs the
sidecar with the user's Bun. A distributable app would copy `sidecar/`, `scene/` (or a writable copy of it in
Application Support), `engine/presets` and a Bun binary into its Resources, set `RT_APP_ROOT` / `RT_APP_BUN`, and be
signed with a Developer ID and notarized. It cannot be sandboxed: it starts the user's own coding agents.
