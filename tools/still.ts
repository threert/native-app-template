// Renders the scene offline to a PNG, without the app: for looking at a change, or for a coding agent outside the app.
//   bun tools/still.ts [out.png] [--time 2] [--room night] [--width 1280 --height 720] [--camera '{"position":[..],"target":[..],"fov":40}']
// Uses the engine's command-line renderer (engine/renderer, built on first use; THREERT_RENDER names another binary).
// The scene's frame script and physics run up to --time seconds of scene time before the picture is traced.
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bundleScene, ENGINE, ROOT } from "../sidecar/src/bundle.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = args.find(a => a.endsWith(".png")) ?? join(ROOT, ".build/still.png");
const bundle = join(ROOT, ".build/still/scene.js");
const built = await bundleScene(join(ROOT, "scene/main.game.ts"), bundle);
if (!built.ok) {
  for (const p of built.problems) console.error(`${p.file ?? ""}${p.line ? `:${p.line}` : ""} ${p.message}`);
  process.exit(1);
}
let bin = process.env.THREERT_RENDER ?? join(ENGINE, "renderer/target/release/threert-render");
if (!existsSync(bin)) {
  console.error("building the engine's renderer (first use, a few minutes)…");
  await $`cargo build --release --bin threert-render`.cwd(join(ENGINE, "renderer"));
}
const extra: string[] = [];
for (const name of ["--time", "--width", "--height", "--camera", "--spp", "--preset", "--room"]) {
  const v = flag(name);
  if (v !== undefined) extra.push(name, v);
}
if (!flag("--width")) extra.push("--width", "1280", "--height", "720");
if (!flag("--time")) extra.push("--time", "2");
const r = await $`${bin} render ${bundle} -o ${out} --assets ${join(ROOT, "scene")} ${extra}`.quiet().nothrow();
if (r.exitCode !== 0) {
  console.error(r.stderr.toString().trim().split("\n").slice(-12).join("\n"));
  process.exit(1);
}
const stats = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
console.log(`${out}  (${stats.triangles} triangles, ${stats.lights} lights, ${stats.emitters} emitters, ${Math.round(stats.timings_ms.total_ms)} ms)`);
const errors = r.stderr.toString().split("\n").filter(l => /error|panic/i.test(l));
if (errors.length) console.error(errors.slice(0, 10).join("\n"));
