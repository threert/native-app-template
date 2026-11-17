// Light and time of day. By day the only light is the sun through the ceiling slots (room.ts SLOTS) plus the sky seen
// through it; everything outside the sheet of sunlight is lit by bounces (global illumination). At night the sun
// is below the horizon, the pendants come on, and the orbs are the show.
//
// Day <-> night is not a switch but a short time-lapse: the sun sinks (or rises) through sunset, the beam slides
// across the room and reddens, the exposure follows, the lamps fade in. The sky is `dynamic`, so moving the sun is
// an in-place update in the live view (no rebuild).
import { DirectionalLight, ExponentialHeightFog, type PerspectiveCamera, type Scene, SkyAtmosphere } from "@threert/scene";

// ------------------------------------------------------------------------------------------------ tunables

/** The sun by day: elevation and azimuth (degrees; azimuth 0 = from +z, the room's front), illuminance (lux). */
export const DAY = { elevation: 52, azimuth: 12, lux: 100000, exposure: 8.2 };
/** The sun's place at night (below the horizon), and the exposure (EV100; lower = brighter picture). */
export const NIGHT = { elevation: -12, azimuth: 40, exposure: 5.6 };
/** Seconds the time-lapse between the two takes. */
export const TRANSITION = 6;
/** The night sky's faint glow through the slot (nits) and its colour. */
export const NIGHT_SKY = { glow: 0x5a6a90, intensity: 0.03 };
/**
 * Dust in the air: makes the sunbeam (and orb halos) visible. `density` per metre; 0 turns it off (cheaper).
 */
export const HAZE = { density: 0.02, scattering: 0.9, anisotropy: 0.65 };
/** The camera's post-processing (UE PostProcessVolume names): glow around bright things, vignette, grade. */
export const POST = {
  bloom: { intensity: 0.55, threshold: 1.0, sizeScale: 4 },
  vignette: 0.35,
  filmGrain: 0.04,
  colorGrading: { whiteTemp: 6200, saturation: 1.02, contrast: 1.04 },
};

// ------------------------------------------------------------------------------------------------ the sky and the clock

export interface Daylight {
  /** True when heading for (or at) night. */
  readonly night: boolean;
  /** 0 = full day .. 1 = full night, as the time-lapse stands now. */
  readonly t: number;
  /** Starts the time-lapse towards the other end. */
  toggle(): void;
  /** Jumps to day or night at once (no time-lapse). */
  set(night: boolean): void;
  /** Advances the time-lapse and places the sun and exposure; returns the pendants' level (0..1). */
  update(dt: number, camera: PerspectiveCamera): number;
}

const smooth = (x: number) => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function buildLighting(scene: Scene, startAtNight: boolean): Daylight {
  const sun = new DirectionalLight(0xffffff, DAY.lux);
  sun.name = "sun";
  scene.add(sun);
  scene.environment = new SkyAtmosphere({ sun, dynamic: true, glow: NIGHT_SKY.glow, glowIntensity: NIGHT_SKY.intensity });
  if (HAZE.density > 0) {
    const fog = new ExponentialHeightFog(HAZE.density, 0, 0x000000); // black: no ambient haze, only lit dust
    fog.setVolumetric(HAZE.scattering, HAZE.anisotropy);
    scene.fog = fog;
  }

  let night = startAtNight;
  let t = night ? 1 : 0;
  let placed = -1;
  return {
    get night() {
      return night;
    },
    get t() {
      return t;
    },
    toggle() {
      night = !night;
    },
    set(n) {
      night = n;
      t = n ? 1 : 0;
    },
    update(dt, camera) {
      t = Math.min(1, Math.max(0, t + (night ? dt : -dt) / TRANSITION));
      const s = smooth(t);
      if (s !== placed) {
        placed = s;
        sun.setSunAngles(mix(DAY.elevation, NIGHT.elevation, s), mix(DAY.azimuth, NIGHT.azimuth, s));
        // Exposure follows the light: slowly at first (the beam is still in), then down to the night's.
        camera.setManualExposure(mix(DAY.exposure, NIGHT.exposure, smooth((s - 0.25) / 0.6)));
      }
      return smooth((s - 0.45) / 0.4);
    },
  };
}
