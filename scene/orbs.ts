// Glowing orbs: the scene's hero interaction. A thrown orb is a heavy glass-like ball that is itself a light source
// (an emissive sphere the path tracer samples as a light): it flies, bounces, rolls, knocks the tower over, and
// lights the room with global illumination as it goes.
//
// How it is built, and why: adding an emissive object or a new material while the scene runs can make the renderer
// rebuild its scene, a visible hitch. So every orb that can ever be live is made in setup (a pool), parked on a
// hidden shelf under the floor with its light off (`power` 0). Throwing one moves it to the camera, gives it a
// velocity and fades its light on; retiring one fades its light off and parks it again. Moving a body and changing
// `power` are both cheap in-place updates.
import { Color, Mesh, MeshStandardMaterial, type Scene, SphereGeometry, Vector3 } from "@threert/scene";
import { kelvin } from "./materials.ts";
import { LIMBO_Y } from "./room.ts";

// ------------------------------------------------------------------------------------------------ tunables

export const ORBS = {
  /** Live orbs at most; throwing one more retires the oldest. */
  max: 12,
  /** Radius (m) and density (kg/m^3: ~6.7 kg, enough to topple a block of the tower). */
  radius: 0.11,
  density: 1200,
  /** Launch speed (m/s) along the view ray, plus a little lift so the throw arcs. */
  speed: 11,
  lift: 1.0,
  /** Surface brightness (nits). An orb's light grows with the square of its radius times this. */
  nits: 12000,
  /** Seconds to fade a light on when thrown and off when retired. */
  fadeIn: 0.12,
  fadeOut: 0.6,
  /** Bounce (0..1) and how quickly rolling dies down. */
  restitution: 0.45,
  rollingDamping: 0.25,
};

/**
 * The colours orbs cycle through, as light: colour temperatures (K) or sRGB hex. Mostly warm-to-cool whites, with a
 * couple of soft accents; saturated colours read as toys.
 */
export const PALETTE: (number | string)[] = [3000, "#ff9a5c", 5200, "#7fd6ff", 2400, 6500, "#ffc2e0", 4000];

// ------------------------------------------------------------------------------------------------ pool

type Phase = "parked" | "live" | "fading";

interface Orb {
  mesh: Mesh;
  phase: Phase;
  /** Seconds in the current phase. */
  age: number;
  /** Thrown order, to retire the oldest first. */
  serial: number;
  home: Vector3;
}

export interface Orbs {
  /** Throws the next orb from `origin` along the unit vector `direction` (at `ORBS.speed` m/s, plus the lift). */
  throw(origin: Vector3, direction: Vector3): void;
  /** Puts the next orb at `at`, already alight, at rest (a room that starts with orbs in it). */
  place(at: Vector3): void;
  /** Fades out every live orb. */
  clear(): void;
  /** Advances the fades; call once a frame. */
  update(dt: number): void;
  /** Live orbs now (not counting ones fading out). */
  readonly live: number;
}

const colourOf = (c: number | string): Color => (typeof c === "number" ? kelvin(c) : new Color(c));

export function buildOrbs(scene: Scene): Orbs {
  // Two spare slots, so orbs fading out don't block new throws.
  const size = ORBS.max + 2;
  const geometry = new SphereGeometry(ORBS.radius, 24, 14);
  const materials = PALETTE.map((c, k) => {
    const colour = colourOf(c);
    // A bright core colour, but not pure: the surface is a hot glass ball, so give it a pale, near-white base.
    return new MeshStandardMaterial({ name: `orb_${k}`, color: 0xffffff, roughness: 0.2, emissive: colour, emissiveIntensity: ORBS.nits });
  });
  const pool: Orb[] = [];
  for (let k = 0; k < size; k++) {
    const mesh = new Mesh(geometry, materials[k % materials.length]);
    mesh.name = `orb_${k}`;
    const home = new Vector3(-6 + k * 0.6, LIMBO_Y + ORBS.radius + 0.01, 0);
    mesh.position.copy(home);
    mesh.power = 0;
    mesh.physics = { type: "dynamic", density: ORBS.density, restitution: ORBS.restitution, friction: 0.5, angularDamping: ORBS.rollingDamping, linearDamping: 0.05, ccd: true };
    // Fell out of the world somehow (through a gap at speed): park it again.
    // (The engine took its body away: set `physics` again for a new one, then put it back on the shelf.)
    mesh.addEventListener("outofworld", () => {
      mesh.physics = { ...mesh.physics! };
      park(orb);
    });
    scene.add(mesh);
    const orb: Orb = { mesh, phase: "parked", age: 0, serial: 0, home };
    pool.push(orb);
  }
  let serial = 0;
  let next = 0; // the palette advances with every throw
  const zero = new Vector3();

  function park(o: Orb) {
    o.phase = "parked";
    o.age = 0;
    o.mesh.power = 0;
    o.mesh.position.copy(o.home);
    o.mesh.setLinearVelocity(zero);
    o.mesh.setAngularVelocity(zero);
  }

  return {
    get live() {
      return pool.filter((o) => o.phase === "live").length;
    },
    throw(origin, direction) {
      launch(origin, direction.clone().multiplyScalar(ORBS.speed).add(new Vector3(0, ORBS.lift, 0)), false);
    },
    place(at) {
      launch(at, zero, true);
    },
    clear() {
      for (const o of pool) if (o.phase === "live") Object.assign(o, { phase: "fading", age: 0 });
    },
    update(dt) {
      for (const o of pool) {
        o.age += dt;
        if (o.phase === "live") {
          const p = Math.min(1, o.age / ORBS.fadeIn);
          if (o.mesh.power !== p) o.mesh.power = p;
        } else if (o.phase === "fading") {
          const p = 1 - o.age / ORBS.fadeOut;
          if (p <= 0) park(o);
          else o.mesh.power = p;
        }
      }
    },
  };

  /** The next parked orb (retiring the oldest live one if all are out) sent from `origin` at `velocity`. */
  function launch(origin: Vector3, velocity: Vector3, lit: boolean) {
    const live = pool.filter((o) => o.phase === "live").sort((a, b) => a.serial - b.serial);
    if (live.length >= ORBS.max) Object.assign(live[0], { phase: "fading", age: 0 });
    // The next parked orb whose colour is next in the palette (else any parked one).
    const parked = pool.filter((o) => o.phase === "parked");
    const o = parked.find((p) => pool.indexOf(p) % PALETTE.length === next % PALETTE.length) ?? parked[0];
    if (!o) return;
    next++;
    o.phase = "live";
    o.age = lit ? ORBS.fadeIn : 0;
    o.mesh.power = lit ? 1 : 0;
    o.serial = ++serial;
    o.mesh.position.copy(origin);
    o.mesh.setLinearVelocity(velocity);
    o.mesh.setAngularVelocity(zero);
  }
}
