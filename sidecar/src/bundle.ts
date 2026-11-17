// Bundles the scene (scene/main.game.ts and what it imports) into one script for the engine's embedded JS runtime:
// the scene's code, @threert/scene and @threert/gameplay from the engine checkout (engine/packages), and the node
// host that the renderer calls into. The same recipe as the engine's tools/bundle-game.ts, with Bun's bundler.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";

export const ROOT = resolve(import.meta.dir, "../..");
export const ENGINE = join(ROOT, "engine");

const PACKAGES: Record<string, string> = {
  "@threert/scene": join(ENGINE, "packages/scene/src/index.ts"),
  "@threert/gameplay": join(ENGINE, "packages/gameplay/src/index.ts"),
  "@threert/voxel": join(ENGINE, "packages/voxel/src/index.ts"),
};

const engineSdk: BunPlugin = {
  name: "threert-sdk",
  setup(build) {
    build.onResolve({ filter: /^@threert\// }, args => {
      const path = PACKAGES[args.path];
      return path ? { path } : undefined;
    });
  },
};

export interface Problem { file?: string; line?: number; column?: number; message: string }
export type BundleResult = { ok: true; out: string; bytes: number; ms: number } | { ok: false; problems: Problem[]; ms: number };

/** Bundles `entry` to `out`. Never throws: a scene that does not build comes back as its problems. */
export async function bundleScene(entry: string, out: string): Promise<BundleResult> {
  const t0 = performance.now();
  const shim = join(dirname(out), "entry.ts");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(shim, [
    `import mod from ${JSON.stringify(resolve(entry))};`,
    `import { defineGame, installNodeHost } from "@threert/gameplay";`,
    `installNodeHost(typeof mod === "function" ? defineGame({ state: {}, setup: () => mod(), handlers: {} }) : mod);`,
  ].join("\n"));
  try {
    const result = await Bun.build({
      entrypoints: [shim],
      format: "iife",
      target: "browser",
      minify: { syntax: true },
      plugins: [engineSdk],
      throw: false,
    });
    const ms = performance.now() - t0;
    if (!result.success) {
      return { ok: false, ms, problems: result.logs.filter(l => l.level === "error").map(l => ({
        file: l.position?.file, line: l.position?.line, column: l.position?.column, message: l.message,
      })) };
    }
    const text = await result.outputs[0].text();
    writeFileSync(out, text);
    return { ok: true, out, bytes: text.length, ms };
  } catch (error) {
    return { ok: false, ms: performance.now() - t0, problems: [{ message: String(error instanceof Error ? error.message : error) }] };
  }
}

if (import.meta.main) {
  const entry = process.argv[2] ?? join(ROOT, "scene/main.game.ts");
  const out = process.argv[3] ?? join(ROOT, ".build/scene/scene.js");
  const r = await bundleScene(entry, out);
  if (r.ok) console.log(`${r.out}: ${(r.bytes / 1024).toFixed(0)} KiB in ${r.ms.toFixed(0)} ms`);
  else { for (const p of r.problems) console.error(`${p.file ?? ""}${p.line ? `:${p.line}` : ""} ${p.message}`); process.exit(1); }
}
