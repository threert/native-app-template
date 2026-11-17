// Pendant lamps: bell-shaped bronze shades on long cords, each hung from a ceiling canopy by a ball joint, so an orb
// (or a flying block) that hits one sets it swinging, and its pool of warm light swings across the floor with it.
// The light is the shade's opal diffuser, an emissive disc: the path tracer samples it as a light source directly,
// so there is no separate light object to keep in step.
import { BallJoint, CircleGeometry, CylinderGeometry, LatheGeometry, Mesh, type Object3D, Quaternion, type Scene, Vector3, Vector2 } from "@threert/scene";
import type { Materials } from "./materials.ts";
import { ROOM } from "./room.ts";

// ------------------------------------------------------------------------------------------------ tunables

/** Each pendant: where it hangs (x, z) and the height of the shade's lower rim above the floor (m). */
export const PENDANTS = [
  { x: -0.9, z: -0.5, rim: 3.0 },
  { x: -2.6, z: -1.6, rim: 2.6 },
  { x: -1.4, z: -2.9, rim: 3.4 },
];
/** The shade's mass (kg) and how quickly a swing dies down (angular damping; 0 swings for ever). */
export const SWING = { mass: 5, damping: 0.15 };

// ------------------------------------------------------------------------------------------------ build

/** The shade's profile, from the cord's end down to the rim (radius, height below the top), m. */
const BELL = [[0.02, 0], [0.05, -0.006], [0.09, -0.03], [0.13, -0.09], [0.165, -0.2], [0.18, -0.27]] as const;
const RIM = -0.27;

export interface Lamps {
  /** Brightness of every pendant, 0 (off) .. 1. */
  setLevel(level: number): void;
  /** Every shade back at rest, hanging straight. */
  reset(): void;
}

export function buildLamps(scene: Scene, m: Materials): Lamps {
  const bell = new LatheGeometry(BELL.map(([x, y]) => new Vector2(x, y)), 40);
  const disc = new CircleGeometry(0.168, 40);
  const canopyGeometry = new CylinderGeometry(0.07, 0.07, 0.04, 24);
  const top = ROOM.height;
  const diffusers: Mesh[] = [];
  const homes: { shade: Object3D; position: Vector3 }[] = [];

  PENDANTS.forEach((p, k) => {
    const cordLength = top - (p.rim - RIM);
    // The canopy: a fixed body on the ceiling the joint holds on to.
    const canopy = new Mesh(canopyGeometry, m.steel);
    canopy.name = `pendant_${k}_canopy`;
    canopy.position.set(p.x, top - 0.02, p.z);
    canopy.physics = "fixed";

    // The shade: the dynamic body. Its origin is where the cord meets it; cord and diffuser are its children and
    // move with it.
    const shade = new Mesh(bell, m.shade);
    shade.name = `pendant_${k}`;
    shade.position.set(p.x, p.rim - RIM, p.z);
    shade.physics = { type: "dynamic", mass: SWING.mass, angularDamping: SWING.damping, linearDamping: 0.02 };
    const cord = new Mesh(new CylinderGeometry(0.004, 0.004, cordLength, 6), m.cord);
    cord.name = `pendant_${k}_cord`;
    cord.position.set(0, cordLength / 2, 0);
    cord.castShadow = false; // a 4 mm cord's shadow is only noise
    const diffuser = new Mesh(disc, m.diffuser);
    diffuser.name = `pendant_${k}_diffuser`;
    diffuser.position.set(0, RIM + 0.03, 0);
    diffuser.rotation.x = Math.PI / 2; // the disc faces down
    shade.add(cord, diffuser);
    diffusers.push(diffuser);

    // Ball joint: the cord's top (in the shade's space) held at the canopy's centre.
    const joint = new BallJoint(canopy, shade, { anchorA: new Vector3(0, 0, 0), anchorB: new Vector3(0, cordLength - 0.02, 0) });
    joint.name = `pendant_${k}_joint`;
    scene.add(canopy, shade, joint);
    homes.push({ shade, position: shade.position.clone() });
  });

  const zero = new Vector3();
  return {
    setLevel(level) {
      for (const d of diffusers) if (d.power !== level) d.power = level;
    },
    reset() {
      for (const h of homes) {
        h.shade.position.copy(h.position);
        h.shade.quaternion.copy(new Quaternion());
        h.shade.setLinearVelocity(zero);
        h.shade.setAngularVelocity(zero);
      }
    },
  };
}
