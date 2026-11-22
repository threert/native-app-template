// Color box: the path tracer's hello world. A room open at the front, lit by nothing but one panel in its ceiling. The
// light bounces: the coral wall and the teal wall tint the ceiling, the floor and everything in between (global
// illumination); the mirror block shows both walls, and the glass sphere bends the room and focuses the panel's light
// onto the floor. Every object is a physics body.
//
// Drag to turn, scroll to zoom, click the floor to drop a cube, R to put everything back.
//
// Files: this one (the room, the light, the objects, the controls), orbit.ts (the camera, clicks, view rays),
// pool.ts (the cubes a click drops, made once in setup).
import {
  BoxGeometry, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, RectAreaLight, Scene, SkyColor, SphereGeometry, Vector3,
} from "@threert/scene";
import { defineGame, hud } from "@threert/gameplay";
import { Orbit } from "./orbit.ts";
import { Pool } from "./pool.ts";

// ------------------------------------------------------------------------------------------------ tunables

/** The room's inside (m): width, height, depth; open toward +z (the camera's side). */
export const ROOM = { width: 4, height: 3, depth: 4, wall: 0.1 };
/** The walls' paint. */
export const WALLS = { left: 0xe0603f, right: 0x2f9c95, rest: 0xf1ede6 };
/** The ceiling panel, the only light: its size (m), luminance (nits) and colour. */
export const PANEL = { size: 1.3, nits: 9000, color: 0xfff4e6 };
/** The camera's exposure (EV100; higher is darker). */
export const EXPOSURE = 9.1;
/** What a click drops: cube size (m), colours, how many there can be at once. */
export const CUBES = { size: 0.3, colors: [0xf2cc8f, 0xe07a5f, 0x81b29a, 0xf1ede6], count: 24 };

// ------------------------------------------------------------------------------------------------ the scene

let orbit: Orbit;
let cubes: Pool;
/** The objects in the room and where they stand, for R. */
let objects: { mesh: Mesh; at: Vector3; yaw: number }[] = [];

function buildRoom(scene: Scene): void {
  const { width: w, height: h, depth: d, wall: t } = ROOM;
  const slab = (size: [number, number, number], at: [number, number, number], color: number) => {
    const mesh = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color, roughness: 0.9 }));
    mesh.position.set(...at);
    mesh.physics = "fixed";
    scene.add(mesh);
  };
  slab([w + 2 * t, t, d], [0, -t / 2, 0], WALLS.rest); // floor
  slab([w + 2 * t, t, d], [0, h + t / 2, 0], WALLS.rest); // ceiling
  slab([w + 2 * t, h + 2 * t, t], [0, h / 2, -d / 2 - t / 2], WALLS.rest); // back
  slab([t, h, d], [-w / 2 - t / 2, h / 2, 0], WALLS.left);
  slab([t, h, d], [w / 2 + t / 2, h / 2, 0], WALLS.right);

  // The light: a rectangle in the ceiling facing down (it is also seen, as a glowing card).
  const panel = new RectAreaLight(PANEL.color, PANEL.nits, PANEL.size, PANEL.size);
  panel.position.set(0, h - 0.005, 0);
  panel.lookAt(0, 0, 0);
  scene.add(panel);
}

function buildObjects(scene: Scene): void {
  const mirror = new MeshStandardMaterial({ color: 0xf2f2f2, metalness: 1, roughness: 0.02 });
  const glass = new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0, transmission: 1, ior: 1.5 });
  const clay = new MeshStandardMaterial({ color: 0xf2cc8f, roughness: 0.55 });
  const place = (mesh: Mesh, at: [number, number, number], yaw = 0) => {
    mesh.position.set(...at);
    mesh.rotation.y = yaw;
    mesh.physics = { type: "dynamic", friction: 0.6, restitution: 0.15 };
    scene.add(mesh);
    objects.push({ mesh, at: new Vector3(...at), yaw });
  };
  objects = [];
  // (The block is turned so that it shows the two coloured walls, not the open front.)
  place(new Mesh(new BoxGeometry(0.9, 1.8, 0.9), mirror), [-0.85, 0.9, -0.75], -0.62);
  place(new Mesh(new SphereGeometry(0.55, 64, 32), glass), [0.85, 0.55, 0.35]);
  place(new Mesh(new SphereGeometry(0.32, 64, 32), clay), [-0.15, 0.32, 0.95]);

  const kinds = CUBES.colors.map((color) => ({
    geometry: new BoxGeometry(CUBES.size, CUBES.size, CUBES.size),
    material: new MeshStandardMaterial({ color, roughness: 0.5 }),
  }));
  cubes = new Pool(scene, kinds, CUBES.count, { friction: 0.6, restitution: 0.2 });
}

/** Everything back where it started, the dropped cubes gone. */
function reset(): void {
  const still = new Vector3();
  for (const o of objects) {
    o.mesh.position.copy(o.at);
    o.mesh.rotation.set(0, o.yaw, 0);
    o.mesh.setLinearVelocity(still);
    o.mesh.setAngularVelocity(still);
  }
  cubes.clear();
}

// ------------------------------------------------------------------------------------------------ the game

export default defineGame({
  state: {},
  handlers: {},
  pointer: "free", // the app sends the pointer and keys every frame (f.input)
  setup() {
    const scene = new Scene();
    scene.environment = new SkyColor(0x000000, 0); // no sky: the panel is the only light
    buildRoom(scene);
    buildObjects(scene);

    const camera = new PerspectiveCamera(40, 16 / 9, 0.05, 100);
    camera.setManualExposure(EXPOSURE);
    scene.add(camera);
    orbit = new Orbit({ target: [0, 1.4, 0], yaw: 0, pitch: 0.05, distance: 6.4, yawRange: [-0.7, 0.7], pitchRange: [-0.2, 0.55], distanceRange: [4.2, 9] });
    orbit.update(camera, 0, true);
    return {
      scene,
      camera,
      options: { name: "color-box", width: 1280, height: 720, preset: "cinematic" as const, overrides: { post: { bloom: { intensity: 0.3, threshold: 1.3 }, vignette: 0.2 } } },
    };
  },
  frame(f) {
    if (f.dt > 0) {
      const click = orbit.input(f);
      if (click) {
        // A cube from just under the ceiling, above the point of the floor that was clicked (inside the room only).
        const at = orbit.pointOn(f.camera, click.u, click.v);
        const inside = at && Math.abs(at.x) < ROOM.width / 2 - CUBES.size && Math.abs(at.z) < ROOM.depth / 2 - CUBES.size;
        if (at && inside) cubes.launch(at.set(at.x, ROOM.height - 0.4, at.z), new Vector3(0, -1, 0), Math.random() * 4 - 2);
      }
      if (f.input.pressed("R")) reset();
    }
    orbit.update(f.camera, f.dt, f.snap);
    hud.set({
      items: [
        { type: "text", anchor: "top-left", label: "Color box", text: "one light, every bounce traced", tone: "dim", size: "small" },
        { type: "text", anchor: "bottom-left", text: "Drag to turn · Scroll to zoom · Click the floor to drop a cube · R to reset", tone: "dim", size: "small" },
      ],
    });
  },
});
