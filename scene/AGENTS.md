# Working on this scene (guide for the coding agent in the app)

You are editing a **ThreeRT scene**: TypeScript that builds a three.js-style scene, which the app path-traces live on
the GPU (hardware ray tracing, global illumination, Rapier physics). The person you work with sees the result in the
window next to your conversation. **Every file you save in this folder is rebuilt and reloaded within a second**:
the scene's `setup` runs again from scratch (state, thrown objects and the camera reset).

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
(a host-channel message the scene receives with `host.on("...")`), `scene state`.

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
- Budgets: setup 120 s, a frame script 50 ms, an event 1 s. Keep per-frame work small: no allocation-heavy loops
  over thousands of objects every frame.
- It is a path tracer at 60 fps: keep geometry moderate (tens of thousands of triangles is fine), prefer few
  large emitters to hundreds of tiny ones, and remember every light and bounce costs.
- Assets (glTF, textures) resolve against this folder. Generate textures in code (`DataTexture`) when you can.
- Don't change files outside this folder (the engine in `../engine`, the app in `../app`, `../core`, `../sidecar`):
  they are not yours, and the person's app depends on them.
