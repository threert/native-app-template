// What stands in the room and can be knocked over: a stacked tower of blocks in mixed materials on a stone plinth,
// a small pyramid of glass cubes, and a glazed ceramic sphere. All are dynamic bodies: orbs, lamps and each other
// push them around. `reset()` puts every one back where setup placed it (the R key).
import { BoxGeometry, Mesh, type MeshStandardMaterial, type Object3D, Quaternion, type Scene, SphereGeometry, Vector3 } from "@threert/scene";
import type { Materials } from "./materials.ts";
import { block } from "./room.ts";

// ------------------------------------------------------------------------------------------------ tunables

/** The tower: where it stands (on a plinth), and one block's size (m): long, high, wide. */
export const TOWER = { at: [0, 0, 0] as const, block: [0.72, 0.14, 0.24] as const, plinth: [1.5, 0.12, 1.5] as const };
/**
 * The tower's layers from the bottom, three blocks each (alternate layers turn 90 degrees, as in Jenga).
 * W walnut, K copper, C ceramic, G clear glass, F frosted glass, "." no block (a game already under way: light
 * passes through the gaps). Add a row to make it taller; keep every layer able to carry the next.
 */
export const LAYERS = ["WWW", "CWC", "WKW", "W.F", "GWW", "WCW", "K.K", "WGW", "FW.", "WWC", ".KW", "WFW", "CW."];
/** A block's mass (kg) by material: close together, so a heavy copper block doesn't anchor the tower. */
const MASS: Record<string, number> = { W: 14, K: 22, C: 17, G: 19, F: 19 };
/** Glass cubes: edge (m), where the pyramid stands, rows from the bottom. */
export const CUBES = { edge: 0.3, at: [2.3, 0, -1.0] as const, rows: [3, 2, 1] };
/** The ceramic sphere: radius (m) and where it rests. */
export const SPHERE = { radius: 0.32, at: [-2.4, 0, 2.2] as const };

// ------------------------------------------------------------------------------------------------ build

interface Home {
  object: Object3D;
  position: Vector3;
  quaternion: Quaternion;
}

export interface Props {
  /** Every dynamic prop back where setup placed it, at rest. */
  reset(): void;
  /** The dynamic props (to find one hit by a ray, or to listen to its contacts). */
  readonly bodies: readonly Object3D[];
}

export function buildProps(scene: Scene, m: Materials, random: () => number): Props {
  const homes: Home[] = [];
  const place = (mesh: Mesh, at: Vector3, yaw = 0, physics: { mass: number; friction?: number; restitution?: number }) => {
    mesh.position.copy(at);
    mesh.rotation.y = yaw;
    mesh.physics = { type: "dynamic", friction: 0.6, restitution: 0.05, ...physics };
    mesh.customData = [random(), random(), 0, 0]; // per-object seed for the wood grain / brushed streaks
    scene.add(mesh);
    const home = { object: mesh, position: at.clone(), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw) };
    homes.push(home);
    // Left the world (it can't through closed walls, but if something ever tunnels out): a new body, back home.
    mesh.addEventListener("outofworld", () => {
      mesh.physics = { ...mesh.physics! };
      mesh.position.copy(home.position);
      mesh.quaternion.copy(home.quaternion);
    });
  };
  const byCode: Record<string, MeshStandardMaterial> = { W: m.walnut, K: m.copper, C: m.ceramic, G: m.glass, F: m.frosted };

  // The plinth (fixed) and the tower on it.
  const [px, , pz] = TOWER.at;
  const [pw, ph, pd] = TOWER.plinth;
  scene.add(block("plinth", [pw, ph, pd], [px, ph / 2, pz], m.travertine));
  const [L, H, Wd] = TOWER.block;
  const geometry = new BoxGeometry(L, H, Wd);
  const gap = 0.004; // a hair between blocks, so none starts inside another
  LAYERS.forEach((row, layer) => {
    const turned = layer % 2 === 1;
    const y = ph + layer * (H + gap) + H / 2 + gap;
    for (let k = 0; k < 3; k++) {
      const code = row[k] ?? "W";
      if (code === ".") continue;
      const off = (k - 1) * (Wd + gap);
      const at = new Vector3(px + (turned ? off : 0), y, pz + (turned ? 0 : off));
      const mesh = new Mesh(geometry, byCode[code] ?? m.walnut);
      mesh.name = `tower_${layer}_${k}`;
      place(mesh, at, turned ? Math.PI / 2 : 0, { mass: MASS[code] ?? 15 });
    }
  });

  // The glass pyramid: rows of cubes, each row centred on the one below.
  const e = CUBES.edge, cube = new BoxGeometry(e, e, e);
  CUBES.rows.forEach((n, row) => {
    for (let k = 0; k < n; k++) {
      const at = new Vector3(CUBES.at[0] + (k - (n - 1) / 2) * (e + 0.01), row * (e + 0.002) + e / 2 + 0.001, CUBES.at[2]);
      const mesh = new Mesh(cube, row === CUBES.rows.length - 1 ? m.frosted : m.glass);
      mesh.name = `cube_${row}_${k}`;
      place(mesh, at, 0.35, { mass: 12 });
    }
  });

  // The ceramic sphere: heavy, rolls slowly when hit.
  const ball = new Mesh(new SphereGeometry(SPHERE.radius, 48, 32), m.ceramic);
  ball.name = "ceramic_sphere";
  place(ball, new Vector3(SPHERE.at[0], SPHERE.radius, SPHERE.at[2]), 0, { mass: 40, friction: 0.8 });

  const zero = new Vector3();
  return {
    bodies: homes.map((h) => h.object),
    reset() {
      for (const h of homes) {
        h.object.position.copy(h.position);
        h.object.quaternion.copy(h.quaternion);
        h.object.setLinearVelocity(zero);
        h.object.setAngularVelocity(zero);
      }
    },
  };
}
