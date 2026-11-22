// The camera: an orbit around a point, driven by the pointer (drag to turn, wheel to come closer), smoothed so it
// glides. It also tells a click from a drag, and turns a point of the picture into the view ray through it.
import { type PerspectiveCamera, Raycaster, Vector2, Vector3 } from "@threert/scene";
import { type FrameContext, host } from "@threert/gameplay";

export interface OrbitOptions {
  /** The point the camera circles and looks at (m). */
  target: [number, number, number];
  /** Where it starts: yaw (radians, 0 = looking from +z toward -z), pitch (radians above level), distance (m). */
  yaw: number;
  pitch: number;
  distance: number;
  /** Limits (radians, m). */
  yawRange?: [number, number];
  pitchRange?: [number, number];
  distanceRange?: [number, number];
}

/** Radians turned by dragging across the whole picture, sideways and up and down. */
const DRAG = { yaw: 4, pitch: 3 };
/** A press that moves less than this (fraction of the picture) before release is a click, not a drag. */
const CLICK_SLOP = 0.006;
/** How quickly the camera catches up with where it is going (1/s). */
const SMOOTHING = 9;

export class Orbit {
  readonly target: Vector3;
  yaw: number;
  pitch: number;
  distance: number;
  /** The picture's width / height: the app says it (`launch`, `view`); 16:9 until it does. */
  aspect = 16 / 9;
  private readonly o: OrbitOptions;
  private cur: { yaw: number; pitch: number; distance: number };
  private press: { u0: number; v0: number; u: number; v: number; dragging: boolean } | null = null;
  private readonly raycaster = new Raycaster();

  constructor(o: OrbitOptions) {
    this.o = o;
    this.target = new Vector3(...o.target);
    this.yaw = o.yaw;
    this.pitch = o.pitch;
    this.distance = o.distance;
    this.cur = { yaw: o.yaw, pitch: o.pitch, distance: o.distance };
    host.on("view", (m) => this.shape(Number(m.width), Number(m.height)));
    host.on("launch", (m) => this.shape(Number(m.params?.width), Number(m.params?.height)));
  }

  /** This frame's drag and wheel; returns where a click (a press and release without a drag) was, (u, v) from the top left. */
  input(f: FrameContext<unknown>): { u: number; v: number } | null {
    const { u, v } = f.input.pointer;
    let click: { u: number; v: number } | null = null;
    if (f.input.pressed("Mouse0")) this.press = { u0: u, v0: v, u, v, dragging: false };
    if (this.press && f.input.button(0)) {
      if (Math.hypot(u - this.press.u0, v - this.press.v0) > CLICK_SLOP) this.press.dragging = true;
      if (this.press.dragging) {
        this.yaw -= (u - this.press.u) * DRAG.yaw;
        this.pitch += (v - this.press.v) * DRAG.pitch;
      }
      this.press.u = u;
      this.press.v = v;
    }
    if (this.press && f.input.released("Mouse0")) {
      if (!this.press.dragging) click = { u: this.press.u0, v: this.press.v0 };
      this.press = null;
    }
    if (f.input.wheel) this.distance *= Math.pow(0.9, f.input.wheel);
    const clamp = (x: number, r: [number, number] | undefined) => (r ? Math.min(r[1], Math.max(r[0], x)) : x);
    this.yaw = clamp(this.yaw, this.o.yawRange);
    this.pitch = clamp(this.pitch, this.o.pitchRange ?? [0.02, 1.2]);
    this.distance = clamp(this.distance, this.o.distanceRange ?? [this.o.distance * 0.5, this.o.distance * 1.6]);
    return click;
  }

  /** Places the camera (smoothed; `snap` jumps there). */
  update(camera: PerspectiveCamera, dt: number, snap = false): void {
    const k = snap ? 1 : 1 - Math.exp(-SMOOTHING * dt);
    this.cur.yaw += (this.yaw - this.cur.yaw) * k;
    this.cur.pitch += (this.pitch - this.cur.pitch) * k;
    this.cur.distance += (this.distance - this.cur.distance) * k;
    const { yaw, pitch, distance } = this.cur;
    camera.position.set(
      this.target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
      this.target.y + Math.sin(pitch) * distance,
      this.target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
    );
    camera.lookAt(this.target.x, this.target.y, this.target.z);
  }

  /** The view ray through (u, v) of the picture. */
  ray(camera: PerspectiveCamera, u: number, v: number): { origin: Vector3; direction: Vector3 } {
    camera.aspect = this.aspect;
    this.raycaster.setFromCamera(new Vector2(u * 2 - 1, 1 - v * 2), camera);
    return { origin: this.raycaster.ray.origin.clone(), direction: this.raycaster.ray.direction.clone().normalize() };
  }

  /** Where the view ray through (u, v) meets the level y = `y`, or null when it doesn't (it points up). */
  pointOn(camera: PerspectiveCamera, u: number, v: number, y = 0): Vector3 | null {
    const { origin, direction } = this.ray(camera, u, v);
    if (direction.y > -1e-3) return null;
    return origin.addScaledVector(direction, (y - origin.y) / direction.y);
  }

  private shape(w: number, h: number): void {
    if (w > 0 && h > 0) this.aspect = w / h;
  }
}
