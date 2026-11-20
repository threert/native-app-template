# Working on this scene (guide for the coding agent in the app)

You are editing a **ThreeRT scene**: TypeScript that builds a three.js-style scene, which the app path-traces live on
the GPU (hardware ray tracing, global illumination, Rapier physics). The person you work with sees the result in the
window next to your conversation. **Every file you save in this folder is rebuilt and reloaded within a second**
(notes, `.md` and `.txt`, are not): the scene's `setup` runs again from scratch (state, thrown objects and the camera
reset). `scene check` reloads it too.

## The loop

1. Read `README.md` here first: what the scene is, its modules, how each part is meant to be changed.
2. Make the change in this folder (your working directory). Only files here are yours to write. Edit files with
   your file-editing tools, not with shell scripts (`python3`, `sed -i`, heredocs): the app lets edits in this
   folder, `scene ...` and read-only commands (`ls`, `cat`, `grep`, `rg`, `sed -n`, `find`) through on their own,
   and asks the person about every other command.
3. Run **`scene check`**. It builds the scene, type-checks it, has the app run it for a second and reports
   build errors, type errors, runtime errors (setup, frame script) and console errors. Fix everything it reports.
4. Run **`scene shot`** and look at the PNG it prints (the live view, as the person sees it) when the change is
   visual. A path tracer converges over a few frames: `scene shot` waits a second first.
5. Say briefly what you changed and how to try it (keys, clicks).

Other commands: `scene logs` (the scene's recent `console.*` lines and errors), `scene send '{"t":"...", ...}'`
(a host-channel message the scene receives with `host.on("...")`), `scene state` (the build, the app's frame rate,
GPU and frame-script time), `scene app '{"t":"app.key","key":"N"}'` (press a key in the view; `"hold": 1.5` keeps it
down; `{"t":"app.pointer","u":0.5,"v":0.5,"click":true}` clicks).

`app.json` here holds the app's words in the agent panel (its title, intro, suggested prompts): change them when
the scene becomes something else.

## The API

- `@threert/scene`: three.js-like objects in **physical units** (metres, kilograms; the sun in lux, point and spot lights in candela, area lights and emission in nits;
  exposure in EV). `Scene`, `Mesh`, geometries, `MeshStandardMaterial` / `MeshPhysicalMaterial` (transmission,
  clearcoat, sheen...), lights, `PerspectiveCamera`, skies (`SkyAtmosphere`, `SkyGradient`), `DataTexture`,
  `Raycaster` (also `intersectPhysics`), physics on objects (`mesh.physics = "dynamic" | "fixed" | "kinematic" | {...}`),
  joints (`HingeJoint`, `BallJoint`, `RopeJoint`, ...). Source: `../engine/packages/scene/src/`.
- `@threert/gameplay`: `defineGame({ setup, frame, on, keys, pointer })`, `host` (messages with the app),
  `hud` (the overlay the app draws: text and list items, a centre message). Source: `../engine/packages/gameplay/src/`.
- The scene reads the mouse and keys as `f.input` in its frame script (`pointer: "free"`): `f.input.pointer` (u, v),
  `pressed("Mouse0")`, `wheel`, `down("Space")`, ... Keys are named by their place on a US keyboard.
- Docs (read the parts you need, they are long): `../engine/docs/RUNTIME.md` (sections "World handlers",
  "Physics", "The host channel", "Input", "HUD"), `../engine/docs/MATERIAL_FUNCTIONS.md` (custom WGSL materials,
  emissive particles, volumes), and for the look of a scene `../engine/.claude/skills/threert-scene-authoring/SKILL.md`.
- Examples: `../engine/games/` (physics, light-room, sun-sweep, fps arena).

## Rules of the runtime

- Scene code runs in an embedded JS runtime (QuickJS) with **no I/O and no timers**: no `fetch`, `setTimeout`, `fs`.
  Animate in the frame script with `f.dt` / `f.time`. `setup` and handlers are synchronous.
- Limits: setup 120 s, an event 1 s, a frame script 50 ms (then it is stopped). But the frame script shares the
  render thread: keep it **under a few milliseconds** (`scene check` warns above 8 ms). No allocation-heavy loops
  over thousands of objects every frame.
- It is a path tracer at 60 fps: keep geometry moderate (tens of thousands of triangles is fine), prefer few
  large emitters to hundreds of tiny ones, and remember every light and bounce costs.
- Assets (glTF, textures) resolve against this folder. Generate textures in code (`DataTexture`) when you can.
- `setup(room)`: the app's room is `"app"`. Offline renders (`bun ../tools/still.ts --room night`) can pass another;
  a scene can read it to start in another state (a still runs no frames, so it is the only way to show one).

## Things that move (and what costs a hitch)

The renderer keeps the scene's geometry on the GPU and rebuilds it when the scene's structure changes. Moving
things is free; changing what exists is not:

- **Make everything in setup.** Adding a mesh with a new material, removing one, or toggling `visible` while the
  game runs makes the renderer rebuild (a visible hitch). For things that come and go (coins, projectiles,
  particles, pickups), make a pool in setup and park the unused ones out of sight (below the floor), then move them
  into place.
- **Say what will move:** a mesh or group the frame script moves every frame gets `movable = true` in setup;
  otherwise its first move rebuilds the scene once. Physics bodies (`physics = "dynamic"`) are movable already.
- **Joints are free:** removing a joint (a thing breaking apart) or adding one is no rebuild.
- **Lights:** change a light's intensity or colour when something happens, not a little every frame: each change
  tells the denoiser the lighting changed, and it keeps less history (a noisier picture). Fade over a second or two
  and stop. Prefer a few bright lights to many dim ones: every glowing surface is sampled.
- Don't change files outside this folder (the engine in `../engine`, the apps in `../macos` (and other platforms), `../core`, `../sidecar`):
  they are not yours, and the person's app depends on them.
