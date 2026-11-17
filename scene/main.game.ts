// Atrium: a tall concrete gallery lit by one slot of sunlight, with a tower of walnut, copper, ceramic and glass
// blocks, three pendant lamps on long cords, and glowing orbs you throw that light the room as they roll.
//
// This file wires the modules together and holds the controls; each module has a block of tunables at its top:
//   room.ts      the architecture (size, the ceiling slot)        props.ts    the tower, glass cubes, ceramic sphere
//   lamps.ts     the swinging pendants                            orbs.ts     the throwable lights
//   lighting.ts  sun, sky, haze, exposure, day <-> night           camera.ts   the orbit camera and the pointer's ray
//   materials.ts every surface (procedural, no texture files)
//
// Controls (the app sends input every frame: `pointer: "free"`): drag to orbit, wheel to zoom, click to throw an orb
// where you point, Space to throw one at the centre, N for day / night, R to reset the room, X to put the orbs out.
import { PerspectiveCamera, Scene, Vector3 } from "@threert/scene";
import { defineGame, type FrameContext, host, hud } from "@threert/gameplay";
import { OrbitCamera } from "./camera.ts";
import { buildLamps, type Lamps } from "./lamps.ts";
import { buildLighting, type Daylight, POST } from "./lighting.ts";
import { makeMaterials } from "./materials.ts";
import { buildOrbs, type Orbs } from "./orbs.ts";
import { buildProps, type Props } from "./props.ts";
import { buildRoom } from "./room.ts";

// ------------------------------------------------------------------------------------------------ tunables

/**
 * How the scene starts. `night`: after dark. `orbs`: points (x, y, z) where orbs are dropped at the start, for a
 * room that is already lit by a few. An offline render can ask for either without editing this: a room id of
 * "night", "orbs" or "night+orbs" (`threert-render render --room night+orbs`).
 */
export const START = { night: false, orbs: [] as [number, number, number][] };
/** Orbs dropped by the "orbs" room id. */
const DEMO_ORBS: [number, number, number][] = [[1.1, 0.3, 1.3], [-1.6, 0.3, 1.9], [2.2, 0.3, -1.4], [-0.6, 0.3, -2.4], [3.4, 0.3, 2.6], [-5.5, 0.7, -2.5]];
/** Keys (US keyboard positions). */
const KEYS = { night: "N", reset: "R", clear: "X", centre: "Space" };
/** A press that moves less than this (fraction of the picture) before release is a click, not a drag. */
const CLICK_SLOP = 0.006;
/** How far in front of the camera a thrown orb appears (m). */
const THROW_OFFSET = 0.5;

// ------------------------------------------------------------------------------------------------ state

// Module state, rebuilt by every setup (the app re-runs setup when the scene is reloaded).
let orbit: OrbitCamera;
let lighting: Daylight;
let lamps: Lamps;
let props: Props;
let orbs: Orbs;
/** The picture's width / height: the app may tell us (a "view" message); 16:9 until it does. */
let aspect = 16 / 9;
/** The current left-button press: where it started, where the pointer was last frame, whether it became a drag. */
let press: { u0: number; v0: number; u: number; v: number; dragging: boolean } | null = null;

host.on("view", (m) => {
  const w = Number(m.width), h = Number(m.height);
  if (w > 0 && h > 0) aspect = w / h;
});
host.on("launch", (m) => {
  const w = Number(m.params.width), h = Number(m.params.height);
  if (w > 0 && h > 0) aspect = w / h;
});

// ------------------------------------------------------------------------------------------------ interactions

/** Throws an orb along the view ray through a point of the picture (0..1 from the top left). */
function throwAt(camera: PerspectiveCamera, u: number, v: number): void {
  const { origin, direction } = orbit.ray(camera, u, v, aspect);
  orbs.throw(origin.addScaledVector(direction, THROW_OFFSET), direction);
}

function resetRoom(): void {
  orbs.clear();
  props.reset();
  lamps.reset();
}

/** One frame of input: orbit by dragging, zoom by wheel, throw by clicking, keys. */
function handleInput(f: FrameContext<unknown>): void {
  const input = f.input;
  const { u, v } = input.pointer;
  if (input.pressed("Mouse0")) press = { u0: u, v0: v, u, v, dragging: false };
  if (press && input.button(0)) {
    if (!press.dragging && Math.hypot(u - press.u0, v - press.v0) > CLICK_SLOP) {
      press.dragging = true;
      orbit.drag(u - press.u0, v - press.v0); // what moved before it counted as a drag
    } else if (press.dragging) orbit.drag(u - press.u, v - press.v);
    press.u = u;
    press.v = v;
  }
  if (press && input.released("Mouse0")) {
    if (!press.dragging) throwAt(f.camera, press.u0, press.v0);
    press = null;
  }
  if (input.wheel) orbit.dolly(input.wheel);
  if (input.pressed(KEYS.centre)) throwAt(f.camera, 0.5, 0.5);
  if (input.pressed(KEYS.night)) lighting.toggle();
  if (input.pressed(KEYS.reset)) resetRoom();
  if (input.pressed(KEYS.clear)) orbs.clear();
}

function showHud(): void {
  const phase = lighting.t <= 0 ? "Day" : lighting.t >= 1 ? "Night" : lighting.night ? "Dusk" : "Dawn";
  hud.set({
    items: [
      { type: "text", anchor: "top-left", label: "Atrium", text: `${phase} · ${orbs.live} ${orbs.live === 1 ? "light" : "lights"}`, tone: "dim", size: "small" },
      { type: "text", anchor: "bottom-left", text: "Drag to orbit · Scroll to zoom · Click to throw a light", tone: "dim", size: "small" },
      { type: "text", anchor: "bottom-left", text: "N  day / night   ·   Space  throw at centre   ·   X  put out lights   ·   R  reset", tone: "dim", size: "small" },
    ],
  });
}

// ------------------------------------------------------------------------------------------------ the game

export default defineGame({
  state: {},
  handlers: {}, // no game state to change: everything here lives in the scene
  pointer: "free",
  setup(ctx) {
    const mode = new Set(ctx.roomId.split("+"));
    const night = START.night || mode.has("night");
    const drops = mode.has("orbs") ? DEMO_ORBS : START.orbs;

    const scene = new Scene();
    const materials = makeMaterials();
    buildRoom(scene, materials);
    props = buildProps(scene, materials, ctx.random);
    lamps = buildLamps(scene, materials);
    orbs = buildOrbs(scene);
    lighting = buildLighting(scene, night);

    const camera = new PerspectiveCamera(40, 16 / 9, 0.05, 100);
    camera.name = "camera";
    scene.add(camera);
    orbit = new OrbitCamera();
    orbit.update(camera, 0, true);
    lamps.setLevel(lighting.update(0, camera));
    press = null;
    for (const p of drops) orbs.place(new Vector3(...p));

    return {
      scene,
      camera,
      options: { name: "atrium", width: 1280, height: 720, preset: "cinematic" as const, overrides: { post: POST } },
    };
  },
  frame(f) {
    if (f.dt > 0) handleInput(f);
    orbit.update(f.camera, f.dt, f.snap);
    orbs.update(f.dt);
    lamps.setLevel(lighting.update(f.dt, f.camera));
    showHud();
  },
});
