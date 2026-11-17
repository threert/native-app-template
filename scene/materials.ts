// Materials of the Atrium: every surface is procedural (no texture files). Each look is a standard three.js-style
// material whose `color`, `roughness` and `metalness` you can change directly, plus, where a surface needs detail,
// a small material function (WGSL run by the path tracer at every hit, docs/MATERIAL_FUNCTIONS.md in the engine)
// that multiplies a pattern into that colour and roughness. So "make the walls warmer" is a `color` change here, and
// "make the boards wider" is a parameter of the function.
//
// Rules the functions follow (keep them when you add one):
// - Helper names start with `atr_` and every function shares the one HELPERS string (the renderer splices all
//   functions into one shader and drops identical helper blocks, so they must be byte-for-byte the same).
// - Fine detail only where it shows: `i.depth == 0u` is a camera hit; indirect bounces get the cheap average look.
// - Patterns that must stick to a moving object read its mesh UVs (`i.uv`), never `i.wp` (world position).
import { Color, MaterialFunction, MeshPhysicalMaterial, MeshStandardMaterial } from "@threert/scene";

// ------------------------------------------------------------------------------------------------ tunables

/** Board-formed concrete: walls, ceiling, benches (sRGB colour, board height and tie-hole grid in metres). */
export const CONCRETE = { color: 0xb9b2a8, roughness: 0.82, board: 0.18, tieGrid: [0.9, 0.72] as const };
/** Polished dark stone floor: slab size (m) and how glossy it is (lower roughness = sharper reflections). */
export const STONE = { color: 0x4a4642, roughness: 0.07, slab: [1.8, 1.2] as const };
/** Tower materials: walnut, brushed copper, glazed ceramic, clear and frosted glass. */
export const WALNUT = { color: 0x6e4a32, roughness: 0.5 };
export const COPPER = { color: 0xd99572, roughness: 0.28 };
export const CERAMIC = { color: 0xe4e0d8, roughness: 0.45, clearcoat: 1 };
export const GLASS = { tint: 0xf2fbf6, ior: 1.5, frostedRoughness: 0.32 };
/** Pendant lamps: shade metal, and the opal diffuser's colour temperature (K) and brightness (nits). */
export const PENDANT = { shade: 0x2b2420, kelvin: 2700, nits: 14000 };

// ------------------------------------------------------------------------------------------------ shared WGSL

const HELPERS = /* wgsl */ `
fn atr_h21(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn atr_noise(p: vec2<f32>) -> f32 {
  let c = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = atr_h21(c);
  let b = atr_h21(c + vec2<f32>(1.0, 0.0));
  let d = atr_h21(c + vec2<f32>(0.0, 1.0));
  let e = atr_h21(c + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
fn atr_fbm(p: vec2<f32>) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var k = 0; k < 4; k = k + 1) {
    s = s + a * atr_noise(q);
    q = q * 2.03 + vec2<f32>(17.1, 9.3);
    a = a * 0.5;
  }
  return s;
}
// World position on the plane a surface faces: floor/ceiling -> xz, walls -> (along the wall, height).
fn atr_planar(wp: vec3<f32>, n: vec3<f32>) -> vec2<f32> {
  let a = abs(n);
  if (a.y > 0.7) { return wp.xz; }
  if (a.x > a.z) { return vec2<f32>(wp.z, wp.y); }
  return vec2<f32>(wp.x, wp.y);
}
`;

// ------------------------------------------------------------------------------------------------ functions

/** Board-formed concrete, world-mapped: horizontal boards of slightly different tone, cloudy variation, tie holes. */
const CONCRETE_FN = new MaterialFunction("atr_concrete", {
  params: { Board: CONCRETE.board, TieX: CONCRETE.tieGrid[0], TieY: CONCRETE.tieGrid[1] },
  helpers: HELPERS,
  code: /* wgsl */ `
    let p = atr_planar(i.wp, i.ng);
    let wall = abs(i.ng.y) < 0.7;
    // Cloudy tone over metres, on every bounce (it is what the room's bounce light is made of).
    var tone = 0.9 + 0.2 * atr_fbm(p * 0.6);
    var rough = o.roughness;
    if (i.depth == 0u) {
      // Boards: each a little lighter or darker, with a thin dark seam; walls only (ceilings are cast flat).
      if (wall) {
        let row = floor(p.y / $Board);
        let fy = fract(p.y / $Board);
        tone = tone * (0.94 + 0.12 * atr_h21(vec2<f32>(row, 3.7)));
        let seam = 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.035, fy)) * (1.0 - smoothstep(0.0, 0.035, 1.0 - fy));
        tone = tone * seam;
        // Grain along the boards: stretched noise.
        tone = tone * (0.95 + 0.1 * atr_noise(vec2<f32>(p.x * 1.5, p.y * 40.0)));
        // Tie holes: small dark plugs on a grid, offset half a cell every other row.
        let cell = vec2<f32>($TieX, $TieY);
        var q = p / cell;
        q.x = q.x + 0.5 * (floor(q.y) % 2.0);
        let d = length((fract(q) - 0.5) * cell);
        let hole = 1.0 - smoothstep(0.012, 0.018, d);
        tone = tone * (1.0 - 0.55 * hole);
        rough = mix(rough, 0.95, hole);
      }
      // Fine speckle (sand and pores).
      tone = tone * (0.93 + 0.14 * atr_noise(p * 160.0));
    }
    o.base = o.base * tone;
    o.roughness = rough;`,
});

/** Honed dark terrazzo in large slabs: cloudy tone, sparse pale chips, a hair of tone per slab, dull seams. */
const STONE_FN = new MaterialFunction("atr_stone", {
  params: { SlabX: STONE.slab[0], SlabZ: STONE.slab[1], Chips: 0.035 },
  helpers: HELPERS,
  code: /* wgsl */ `
    let p = i.wp.xz;
    let slab = vec2<f32>($SlabX, $SlabZ);
    let cell = floor(p / slab);
    let f = fract(p / slab) * slab;
    let h = atr_h21(cell + 7.0);
    var tone = (0.9 + 0.2 * h) * (0.8 + 0.4 * atr_fbm(p * 0.5 + h * 7.0));
    var rough = o.roughness * (0.85 + 0.3 * atr_h21(cell + 1.3));
    if (i.depth == 0u) {
      // Chips of pale stone in the dark binder: cells of noise, the brightest few percent.
      let c = atr_noise(p * 55.0 + h * 31.0);
      let chip = smoothstep(1.0 - $Chips, 1.0 - $Chips * 0.6, c);
      tone = mix(tone, 1.8, chip * 0.7);
      // Polish is never perfect: faint cloudy roughness.
      rough = rough * (0.7 + 0.6 * atr_fbm(p * 1.8 + 3.0));
      // Seams between slabs: 3 mm, dark and dull.
      let e = min(min(f.x, slab.x - f.x), min(f.y, slab.y - f.y));
      let seam = 1.0 - smoothstep(0.0015, 0.003, e);
      tone = mix(tone, 0.25, seam);
      rough = mix(rough, 0.6, seam);
    }
    o.base = o.base * tone;
    o.roughness = rough;`,
});

/**
 * Walnut on mesh UVs (the grain sticks to a falling block): long growth lines along u, warped, with a per-block
 * seed in `customData[0]` so no two blocks match.
 */
const WOOD_FN = new MaterialFunction("atr_wood", {
  params: { Rings: 6, Contrast: 0.5 },
  helpers: HELPERS,
  code: /* wgsl */ `
    let seed = i.custom.x * 17.0;
    let uv = i.uv + vec2<f32>(seed, seed * 0.37);
    let warp = atr_fbm(vec2<f32>(uv.x * 1.5, uv.y * 2.0)) * 1.4;
    let rings = fract(uv.y * $Rings + warp + atr_noise(vec2<f32>(uv.x * 12.0, uv.y * 3.0)) * 0.08);
    let late = smoothstep(0.45, 0.95, rings) * (1.0 - smoothstep(0.95, 1.0, rings));
    // Each block cut from a different board: a little lighter or darker.
    var tone = mix(1.0 + $Contrast * 0.3, 1.0 - $Contrast * 0.7, late) * (0.85 + 0.3 * i.custom.y);
    if (i.depth == 0u) {
      // Pores: fine dark dashes along the grain.
      tone = tone * (0.9 + 0.1 * atr_noise(vec2<f32>(uv.x * 6.0, uv.y * 300.0)));
    }
    o.base = o.base * tone;
    o.roughness = o.roughness * mix(0.9, 1.2, late);`,
});

/** Brushed metal on mesh UVs: fine streaks along u that make the highlight streak too. */
const BRUSHED_FN = new MaterialFunction("atr_brushed", {
  params: { Streaks: 500 },
  helpers: HELPERS,
  code: /* wgsl */ `
    let s = atr_noise(vec2<f32>(i.uv.x * 4.0 + i.custom.x * 9.0, i.uv.y * $Streaks));
    o.roughness = o.roughness * (0.7 + 0.6 * s);
    o.base = o.base * (0.92 + 0.12 * s);`,
});

// ------------------------------------------------------------------------------------------------ materials

/** A colour temperature in kelvin as linear RGB (a fit of the Planckian locus, 1000-12000 K, scaled to max 1). */
export function kelvin(k: number): Color {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.pow(Math.min(255, Math.max(0, v)) / 255, 2.2);
  return new Color().setRGB(c(r), c(g), c(b));
}

/** Every material of the room, made once in setup and shared (a material per object would cost table entries). */
export function makeMaterials() {
  const concrete = new MeshStandardMaterial({ name: "concrete", color: CONCRETE.color, roughness: CONCRETE.roughness });
  concrete.shader = CONCRETE_FN.with();
  const plaster = new MeshStandardMaterial({ name: "plaster", color: 0xd8d3cb, roughness: 0.9 });
  plaster.shader = CONCRETE_FN.with();
  const stone = new MeshStandardMaterial({ name: "stone", color: STONE.color, roughness: STONE.roughness });
  stone.shader = STONE_FN.with();
  const travertine = new MeshStandardMaterial({ name: "travertine", color: 0xcfc4b0, roughness: 0.6 });
  travertine.shader = CONCRETE_FN.with({ Board: 0.4 });

  const walnut = new MeshStandardMaterial({ name: "walnut", color: WALNUT.color, roughness: WALNUT.roughness });
  walnut.shader = WOOD_FN.with();
  const copper = new MeshStandardMaterial({ name: "copper", color: COPPER.color, metalness: 1, roughness: COPPER.roughness });
  copper.shader = BRUSHED_FN.with();
  const ceramic = new MeshPhysicalMaterial({ name: "ceramic", color: CERAMIC.color, roughness: CERAMIC.roughness, clearcoat: CERAMIC.clearcoat, clearcoatRoughness: 0.05 });
  const glass = new MeshPhysicalMaterial({ name: "glass", color: GLASS.tint, roughness: 0, transmission: 1, ior: GLASS.ior });
  const frosted = new MeshPhysicalMaterial({ name: "frosted", color: GLASS.tint, roughness: GLASS.frostedRoughness, transmission: 1, ior: GLASS.ior });

  const shade = new MeshStandardMaterial({ name: "shade", color: PENDANT.shade, metalness: 1, roughness: 0.35, side: "double" });
  const shadeInside = new MeshStandardMaterial({ name: "shade_inside", color: 0xf0ece4, roughness: 0.6, side: "double" });
  const diffuser = new MeshStandardMaterial({ name: "diffuser", color: 0xffffff, roughness: 0.5, emissive: kelvin(PENDANT.kelvin), emissiveIntensity: PENDANT.nits });
  const cord = new MeshStandardMaterial({ name: "cord", color: 0x111111, roughness: 0.6 });
  const steel = new MeshStandardMaterial({ name: "steel", color: 0x8a8a88, metalness: 1, roughness: 0.4 });
  return { concrete, plaster, stone, travertine, walnut, copper, ceramic, glass, frosted, shade, shadeInside, diffuser, cord, steel };
}

export type Materials = ReturnType<typeof makeMaterials>;
