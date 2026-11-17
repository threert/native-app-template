// The camera: an orbit around a point in the room, driven by the pointer (drag to turn, wheel to come closer), with
// smoothing so it glides rather than jumps, and kept inside the walls. It also turns a pointer position into the
// view ray through it, for throwing orbs where the player clicked.
import { type PerspectiveCamera, Raycaster, Vector2, Vector3 } from "@threert/scene";
import { ROOM } from "./room.ts";

// ------------------------------------------------------------------------------------------------ tunables

export const ORBIT = {
  /** The point the camera circles and looks at (m). */
  target: [0, 1.15, 0] as const,
  /** Where it starts: yaw (radians, 0 = looking from +z toward -z), pitch (radians above level), distance (m). */
  yaw: 0.62,
  pitch: 0.1,
  distance: 6.6,
  /** Limits: pitch (radians) and distance (m). */
  pitchRange: [-0.12, 1.15] as const,
  distanceRange: [2.2, 9] as const,
  /** Radians turned by dragging across the whole picture. */
  dragSpeed: 4.0,
  /** Each wheel notch moves this fraction of the distance. */
  wheelStep: 0.1,
  /** How quickly the camera catches up with where it is going (1/s; higher = snappier). */
  smoothing: 9,
  /** Vertical field of view (degrees). */
  fov: 42,
  /** How close the camera may come to a wall, the floor or the ceiling (m). */
  margin: 0.35,
};

// ------------------------------------------------------------------------------------------------ orbit

export class OrbitCamera {
  readonly target = new Vector3(...ORBIT.target);
  /** Where the camera is heading (set by input). */
  yaw = ORBIT.yaw;
  pitch = ORBIT.pitch;
  distance = ORBIT.distance;
  /** Where it is now (follows the above, smoothed). */
  private cur = { yaw: ORBIT.yaw, pitch: ORBIT.pitch, distance: ORBIT.distance };
  private readonly raycaster = new Raycaster();

  /** Turns by a pointer motion (fractions of the picture: right and down positive). */
  drag(du: number, dv: number): void {
    this.yaw -= du * ORBIT.dragSpeed;
    this.pitch = clamp(this.pitch + dv * ORBIT.dragSpeed * 0.6, ...ORBIT.pitchRange);
  }

  /** Comes closer (positive notches) or backs off. */
  dolly(notches: number): void {
    this.distance = clamp(this.distance * Math.pow(1 - ORBIT.wheelStep, notches), ...ORBIT.distanceRange);
  }

  /** Back to the starting view. */
  reset(): void {
    [this.yaw, this.pitch, this.distance] = [ORBIT.yaw, ORBIT.pitch, ORBIT.distance];
  }

  /** Moves `camera` one frame toward the target view; `snap` jumps there. */
  update(camera: PerspectiveCamera, dt: number, snap = false): void {
    const k = snap ? 1 : 1 - Math.exp(-ORBIT.smoothing * dt);
    this.cur.yaw += (this.yaw - this.cur.yaw) * k;
    this.cur.pitch += (this.pitch - this.cur.pitch) * k;
    this.cur.distance += (this.distance - this.cur.distance) * k;
    const { yaw, pitch } = this.cur;
    const dir = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const d = Math.min(this.cur.distance, roomReach(this.target, dir));
    camera.fov = ORBIT.fov;
    camera.position.copy(this.target).addScaledVector(dir, d);
    camera.lookAt(this.target.x, this.target.y, this.target.z);
  }

  /**
   * The view ray through a point of the picture (`u`, `v`: 0..1 from the top left), for a picture `aspect` wide
   * (width / height). Returns the camera's position and the unit direction.
   */
  ray(camera: PerspectiveCamera, u: number, v: number, aspect: number): { origin: Vector3; direction: Vector3 } {
    camera.aspect = aspect;
    this.raycaster.setFromCamera(new Vector2(u * 2 - 1, 1 - v * 2), camera);
    return { origin: this.raycaster.ray.origin.clone(), direction: this.raycaster.ray.direction.clone().normalize() };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How far from `from` along `dir` the camera may go before it is `margin` from a wall, the floor or the ceiling. */
function roomReach(from: Vector3, dir: Vector3): number {
  const m = ORBIT.margin;
  const lo = [-ROOM.width / 2 + m, m, -ROOM.depth / 2 + m], hi = [ROOM.width / 2 - m, ROOM.height - m, ROOM.depth / 2 - m];
  const p = [from.x, from.y, from.z], d = [dir.x, dir.y, dir.z];
  let reach = Infinity;
  for (let a = 0; a < 3; a++) {
    if (d[a] > 1e-6) reach = Math.min(reach, (hi[a] - p[a]) / d[a]);
    else if (d[a] < -1e-6) reach = Math.min(reach, (lo[a] - p[a]) / d[a]);
  }
  return Math.max(0.5, reach);
}
