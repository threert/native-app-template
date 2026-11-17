// The Atrium itself: a tall concrete room with a polished stone floor and a slot cut through the ceiling. The sun
// shines through the slot as a sharp sheet of light; everything else in the room is lit by what that sheet bounces.
// Every part is a box with a fixed physics body, so orbs and blocks collide with walls, floor, ceiling and benches.
//
// Coordinates: metres, y up, the floor's top at y = 0, the room centred on the origin. The camera orbits inside.
import { BoxGeometry, Mesh, type MeshStandardMaterial, type Scene } from "@threert/scene";
import type { Materials } from "./materials.ts";

// ------------------------------------------------------------------------------------------------ tunables

/** Interior size (m): x from -width/2 to width/2, z likewise, floor at 0, ceiling at `height`. */
export const ROOM = { width: 14, depth: 16, height: 8, wall: 0.4, ceiling: 0.3 };
/**
 * Slots cut through the ceiling, running along x: centre line (z, m), width across (m), length along x (m). With the
 * sun's angles in lighting.ts they decide where sunlight lands. The first throws a thin sheet of light across the
 * room, through the tower; the second lays a broad band of sun across the back wall (most of the day's bounce light
 * comes from there).
 */
export const SLOTS = [
  { z: 5.3, width: 0.7, length: 8 },
  { z: -4.5, width: 1.0, length: 9 },
];
/** Where the parked (not yet thrown) orbs wait: a hidden shelf this far under the floor. */
export const LIMBO_Y = -3;

// ------------------------------------------------------------------------------------------------ build

/** A box that stands still: a mesh with a fixed body (its collider is the box). */
export function block(name: string, size: [number, number, number], at: [number, number, number], material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...at);
  mesh.physics = "fixed";
  return mesh;
}

export function buildRoom(scene: Scene, m: Materials): void {
  const { width: W, depth: D, height: H, wall: T, ceiling: C } = ROOM;
  const hw = W / 2, hd = D / 2;
  // Floor slab and the four walls (wrapped around the interior, corners overlapping).
  scene.add(
    block("floor", [W + 2 * T, 0.4, D + 2 * T], [0, -0.2, 0], m.stone),
    block("wall_back", [W + 2 * T, H + C, T], [0, (H + C) / 2, -hd - T / 2], m.concrete),
    block("wall_front", [W + 2 * T, H + C, T], [0, (H + C) / 2, hd + T / 2], m.concrete),
    block("wall_left", [T, H + C, D], [-hw - T / 2, (H + C) / 2, 0], m.concrete),
    block("wall_right", [T, H + C, D], [hw + T / 2, (H + C) / 2, 0], m.concrete),
  );

  // Ceiling: full-width strips between the slots, and each slot's two end pieces.
  const y = H + C / 2;
  const slots = [...SLOTS].sort((a, b) => a.z - b.z);
  let z = -hd;
  slots.forEach((s, k) => {
    const s0 = s.z - s.width / 2, s1 = s.z + s.width / 2, sx = s.length / 2;
    if (s0 - z > 1e-3) scene.add(block(`ceiling_${k}`, [W, C, s0 - z], [0, y, (z + s0) / 2], m.plaster));
    scene.add(
      block(`ceiling_${k}_left`, [hw - sx, C, s.width], [-(hw + sx) / 2, y, s.z], m.plaster),
      block(`ceiling_${k}_right`, [hw - sx, C, s.width], [(hw + sx) / 2, y, s.z], m.plaster),
    );
    z = s1;
  });
  if (hd - z > 1e-3) scene.add(block("ceiling_last", [W, C, hd - z], [0, y, (z + hd) / 2], m.plaster));

  // A long low bench cast with the left wall, and a shorter one on the right: somewhere for orbs to come to rest
  // and a ledge for the sunlight to catch.
  scene.add(
    block("bench_left", [0.55, 0.42, 6.5], [-hw + 0.275, 0.21, -1.5], m.concrete),
    block("bench_back", [4.2, 0.42, 0.55], [2.6, 0.21, -hd + 0.275], m.concrete),
  );

  // The hidden shelf under the floor that parked orbs rest on (orbs.ts).
  const limbo = block("limbo", [W, 0.2, 2], [0, LIMBO_Y - 0.1, 0], m.concrete);
  limbo.visible = false;
  scene.add(limbo);
}
